/**
 * Diagnostics of the nodes: what an administrator keeps of a node that misbehaves (the latest diagnostic package and log it delivered), the download of both, and the read-only diagnostic tokens an
 * administrator issues so that somebody else can look at the nodes they choose, and at nothing else, for a limited time. See ../diagnostic_tokens.ts for what a token is and is not.
 *
 * Two kinds of caller meet here and never mix. An administrator (a signed-in session; issuing a token needs a fresh proof of identity, the password or the second factor) manages tokens and
 * reads what the nodes delivered. A token (`Authorization: Bearer armor-diag-...`, no session, no cookie) can only GET the four routes under /api/v1/diagnostics/nodes, for the nodes it covers;
 * a token on any other route is no credential at all. Everything a token reads is washed a second time of anything that looks like a credential, and the node's own report is shown without the name
 * of the person who last ordered it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { bearerOf, DiagnosticError, readTokenRequest } from "../diagnostic_tokens.js";
import { NODE_ID, personFor } from "../node_control.js";
import { washCredentials, withoutSensorAddresses, type DiagnosticPackage } from "../node_diag_contract.js";
import type { NodeHealthDetail } from "../node_health.js";

const invalidToken = { error: "not a valid token", code: "invalid_token" };

export function registerDiagnosticsRoutes(app: Express, context: AppContext): void {
  const { requireAdmin, studioSessions, audit, studioUser, nodeHealth, diagnosticTokens, nodeDiagnostics } = context;
  const actor = (request: Request): string => personFor(studioUser(request)?.username);
  const issueLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many tokens asked for", code: "rate_limited" } });
  // A token is read over the network by a stranger as well: the whole of its routes share a budget per address, and a refused attempt costs five times more, so a guess does not get far.
  const readLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many requests", code: "rate_limited" } });

  /** A fresh proof, always: a token opens the logs of the house to somebody who has no account, so a stolen session must not be able to make one. */
  const requireFreshProof: RequestHandler = (request, response, next) => {
    if (studioSessions.elevated(request)) return next();
    audit.record({ action: "elevation.needed", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(403).json({ error: "this needs the password or the code again", code: "elevation_required" });
  };
  const fail = (response: Response, error: unknown): Response => {
    if (error instanceof DiagnosticError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };

  // ---- the administrator ---------------------------------------------------------------------------------------------------------------------

  app.post("/api/v1/diagnostics/tokens", requireAdmin, requireFreshProof, issueLimit, (request, response) => {
    try {
      const input = readTokenRequest(request.body);
      const unknown = input.nodes.filter(node => !nodeHealth.get(node));
      if (unknown.length > 0) throw new DiagnosticError("unknown_node", `no node of that name has reported: ${unknown.join(", ")}`, 404);
      return response.status(201).json(diagnosticTokens.issue(input, actor(request)));
    } catch (error) {
      if (error instanceof DiagnosticError && error.code === "invalid_request") audit.record({ action: "diagnostics.token_issue", outcome: "denied", actor: studioUser(request)?.username, detail: error.message.slice(0, 120) });
      return fail(response, error);
    }
  });

  app.get("/api/v1/diagnostics/tokens", requireAdmin, (_request, response) => response.json({ tokens: diagnosticTokens.list() }));

  app.delete("/api/v1/diagnostics/tokens/:id", requireAdmin, (request, response) => {
    return diagnosticTokens.revoke(String(request.params.id), actor(request)) ? response.sendStatus(204) : response.status(404).json({ error: "no active token of that id", code: "not_found" });
  });

  // What a node delivered when it was asked, and the same as a file to keep.
  app.get("/api/v1/nodes/:id/diagnostics", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    if (!NODE_ID.test(id) || !nodeHealth.get(id)) return response.status(404).json({ error: "no such node", code: "not_found" });
    return response.json({ node_id: id, ...nodeDiagnostics.get(id) });
  });

  app.get("/api/v1/nodes/:id/diagnostics/package", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    const kept = NODE_ID.test(id) ? nodeDiagnostics.get(id).package : undefined;
    if (!kept) return response.status(404).json({ error: "that node has delivered no package", code: "no_package" });
    audit.record({ action: "diagnostics.download", outcome: "allowed", actor: studioUser(request)?.username, target: id, detail: "package" });
    if (request.query.download === "1") response.set("Content-Disposition", `attachment; filename="armor-diagnostics-${id}.json"`);
    return response.json({ node_id: id, at: kept.at, package: kept.data });
  });

  app.get("/api/v1/nodes/:id/diagnostics/log", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    const kept = NODE_ID.test(id) ? (nodeDiagnostics.get(id).log ?? nodeDiagnostics.get(id).package) : undefined;
    if (!kept) return response.status(404).json({ error: "that node has delivered no log", code: "no_log" });
    audit.record({ action: "diagnostics.download", outcome: "allowed", actor: studioUser(request)?.username, target: id, detail: "log" });
    response.type("text/plain; charset=utf-8");
    if (request.query.download === "1") response.set("Content-Disposition", `attachment; filename="armor-log-${id}.txt"`);
    return response.send(kept.data.log);
  });

  // ---- the token -----------------------------------------------------------------------------------------------------------------------------

  /** The caller must hold a token that covers `:id` (or, with no `:id`, any token). Every refusal of a stranger is the same answer. */
  const withToken = (needsNode: boolean): RequestHandler => (request, response, next) => {
    const key = request.ip ?? "unknown";
    if (diagnosticTokens.blocked(key)) return response.status(429).json({ error: "too many requests", code: "rate_limited" });
    const secret = bearerOf(request.header("authorization"));
    const node = needsNode ? String(request.params.id) : undefined;
    if (needsNode && !NODE_ID.test(node as string)) { diagnosticTokens.failed(key); return response.status(401).json(invalidToken); }
    const checked = diagnosticTokens.verify(secret, node);
    if (checked.ok) {
      response.locals.diagnosticToken = { id: checked.id, nodes: checked.nodes };
      return next();
    }
    if (checked.reason === "rate_limited") return response.status(429).json({ error: "too many requests", code: "rate_limited" });
    if (checked.reason === "scope") { diagnosticTokens.failed(key, 1); return response.status(403).json({ error: "that token does not cover this node", code: "out_of_scope" }); }
    diagnosticTokens.failed(key);
    // An unknown secret, an expired one and a revoked one are the same answer to the caller; the audit trail knows which it was (for a token that exists).
    diagnosticTokens.refused(diagnosticTokens.idOf(secret), checked.reason);
    return response.status(401).json(invalidToken);
  };
  const covered = (response: Response): string[] => (response.locals.diagnosticToken as { nodes: string[] }).nodes;

  app.get("/api/v1/diagnostics/nodes", readLimit, withToken(false), (_request, response) => {
    const nodes = covered(response).map(id => {
      const view = nodeHealth.get(id);
      return { node_id: id, ...(view ? { family: view.family, firmware: view.firmware, status: view.status } : { status: "unknown" }), ...nodeDiagnostics.when(id) };
    });
    return response.json({ scope: "read_only", nodes });
  });

  app.get("/api/v1/diagnostics/nodes/:id", readLimit, withToken(true), (request, response) => {
    const detail = nodeHealth.get(String(request.params.id));
    return detail ? response.json(forToken(detail)) : response.status(404).json({ error: "that node has not reported", code: "not_found" });
  });

  app.get("/api/v1/diagnostics/nodes/:id/package", readLimit, withToken(true), (request, response) => {
    const kept = nodeDiagnostics.get(String(request.params.id)).package;
    return kept ? response.json({ node_id: String(request.params.id), at: kept.at, package: washed(kept.data) }) : response.status(404).json({ error: "that node has delivered no package", code: "no_package" });
  });

  app.get("/api/v1/diagnostics/nodes/:id/log", readLimit, withToken(true), (request, response) => {
    const entry = nodeDiagnostics.get(String(request.params.id));
    const kept = entry.log ?? entry.package;
    if (!kept) return response.status(404).json({ error: "that node has delivered no log", code: "no_log" });
    return response.json({ node_id: String(request.params.id), at: kept.at, log: washCredentials(kept.data.log), truncated: kept.data.truncated });
  });
}

/** The package for a token: the log and every text washed again. The structure is already what the strict reader allowed. */
function washed(data: DiagnosticPackage): DiagnosticPackage {
  const copy = structuredClone(data);
  copy.log = washCredentials(copy.log);
  if (copy.config) for (const [name, value] of Object.entries(copy.config)) if (typeof value === "string") copy.config[name] = washCredentials(value);
  return copy;
}

/** The health of a node as a token sees it: the report and the log of restarts, with the last error washed and without the name of the person who last ordered the node. */
function forToken(detail: NodeHealthDetail): Omit<NodeHealthDetail, "report" | "control"> & { report: Omit<NodeHealthDetail["report"], "control_by">; control?: Omit<NonNullable<NodeHealthDetail["control"]>, "by" | "window"> & { window?: { source: string; reason: string; remaining_s: number } } } {
  const { control_by: _person, ...report } = withoutSensorAddresses(detail.report);
  const { control, ...rest } = detail;
  let shown: ReturnType<typeof forToken>["control"];
  if (control) {
    const { by: _by, window, ...state } = control;
    shown = { ...state, ...(window ? { window: { source: window.source, reason: window.reason, remaining_s: window.remaining_s } } : {}) };
  }
  return { ...rest, report: { ...report, ...(report.last_error !== undefined ? { last_error: washCredentials(report.last_error) } : {}) }, ...(shown ? { control: shown } : {}) };
}
