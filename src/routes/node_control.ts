/**
 * Controlling the nodes from Studio and the phone: restart, pause, resume, standby, identify, diagnostics and maintenance, for one node or for every node that reports, and the list of what
 * was ordered. Every order is for an administrator who proved themselves again a moment ago (the password or the second factor, whatever the origin), the node's name (or the word of the
 * operation for every node) is typed again where the house would be left less guarded, and the server and the CM5 are never ordered: only a node that reports is. See ../node_control_service.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { ControlError, COMMAND_ID, NODE_ID, personFor, readControlRequest } from "../node_control.js";
import { NodeControlService } from "../node_control_service.js";

export function registerNodeControlRoutes(app: Express, context: AppContext): void {
  const { requireAdmin, requireOperator, studioSessions, audit, studioUser, nodeControl, nodeHealth, originOfRequest } = context;
  const actor = (request: Request): string => personFor(studioUser(request)?.username);
  const orderLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many orders to nodes", code: "rate_limited" } });
  /** A fresh proof, always: restarting an alarm panel or switching a radar off is not something a stolen session should be able to do from inside the house either. */
  const requireFreshProof: RequestHandler = (request, response, next) => {
    if (studioSessions.elevated(request)) return next();
    audit.record({ action: "elevation.needed", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(403).json({ error: "this needs the password or the code again", code: "elevation_required" });
  };
  const fail = (response: Response, error: unknown) => {
    if (error instanceof ControlError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };
  const origin = (request: Request): string => studioSessions.originOf(request) ?? originOfRequest(request);

  // The planned-maintenance windows in force (a node's own announcement and an operator's, one window per node); any signed-in user may read them.
  app.get("/api/v1/nodes/maintenance", requireOperator, (_request, response) => response.json({ windows: nodeControl.windows() }));

  app.get("/api/v1/nodes/control/operations", requireAdmin, (_request, response) => response.json({ operations: nodeControl.list() }));

  app.get("/api/v1/nodes/control/operations/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    const found = COMMAND_ID.test(id) ? nodeControl.get(id) : undefined;
    return found ? response.json(found) : response.status(404).json({ error: "no such operation", code: "unknown_operation" });
  });

  // One order to every node that reports.
  app.post("/api/v1/nodes/control", requireAdmin, requireFreshProof, orderLimit, (request, response) => {
    try {
      const input = readControlRequest(request.body, "all");
      const views = nodeHealth.list().filter(view => !view.stale);
      // A node that is already as the order would leave it has nothing to do: its line says so without anything being sent to it.
      const skipped = views.filter(view => NodeControlService.alreadyIn(input.operation, view));
      const targets = views.filter(view => !skipped.includes(view)).map(view => ({ id: view.node_id, family: view.family }));
      if (views.length === 0) throw new ControlError("no_nodes", "no node has reported lately", 409);
      if (targets.length === 0) throw new ControlError("already_in_state", "every node is already in that state", 409);
      const started = nodeControl.start({ scope: "all", operation: input.operation, mode: input.mode, duration_s: input.duration_s, actor: actor(request), origin: origin(request), targets });
      return response.status(202).json(started);
    } catch (error) { return fail(response, error); }
  });

  // One order to one node.
  app.post("/api/v1/nodes/:id/control", requireAdmin, requireFreshProof, orderLimit, (request, response) => {
    const id = String(request.params.id);
    try {
      if (!NODE_ID.test(id) || id === "all") throw new ControlError("invalid_request", "that is not the name of a node", 400);
      const view = nodeHealth.get(id);
      if (!view) throw new ControlError("unknown_node", "no node of that name has reported", 404);
      const input = readControlRequest(request.body, "node", [id]);
      if (view.stale) throw new ControlError("node_unavailable", "the node has not reported lately", 409);
      if (NodeControlService.alreadyIn(input.operation, view)) throw new ControlError("already_in_state", "the node is in that state already", 409);
      const started = nodeControl.start({ scope: "node", operation: input.operation, mode: "now", duration_s: input.duration_s, detail: input.detail, actor: actor(request), origin: origin(request), targets: [{ id, family: view.family }] });
      return response.status(202).json(started);
    } catch (error) {
      if (error instanceof ControlError && error.code === "invalid_request") audit.record({ action: "node_control.request", outcome: "denied", actor: studioUser(request)?.username, target: id.slice(0, 64), detail: error.message.slice(0, 120) });
      return fail(response, error);
    }
  });
}
