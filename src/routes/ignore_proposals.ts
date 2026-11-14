/**
 * The areas to ignore that the observation service proposes while the setting `ai.learn` is on (off by default).
 *   POST /api/v1/ai/ignore-proposals           the observation service proposes the busy parts of a camera's picture (kept only while ai.learn is on)
 *   GET  /api/v1/ignore-proposals              an operator: the proposals that wait for a decision (empty while ai.learn is off)
 *   POST /api/v1/ignore-proposals/:id   an administrator accepts (the rectangles join the areas the camera ignores) or rejects (dropped, not proposed again)
 * Nothing is applied until an administrator accepts it, and the decision is written in the audit trail.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { IgnoreZonesInvalid } from "../ignore_zones.js";
import { IgnoreProposals } from "../ignore_proposals.js";

export function registerIgnoreProposalRoutes(app: Express, context: AppContext): void {
  const { audit, vault, requireAi, requireOperator, requireAdmin, ignoreProposals, ignoreZones, securitySettings, studioUser } = context;
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const learning = (): boolean => securitySettings.get("ai.learn");
  const who = (request: Request): string | undefined => studioUser(request)?.username;

  app.post("/api/v1/ai/ignore-proposals", requireAi, limit, (request, response) => {
    const body = request.body as { camera_id?: unknown; zones?: unknown } | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "camera_id" && key !== "zones")) return response.status(422).json({ error: "invalid_proposal" });
    if (typeof body.camera_id !== "string") return response.status(422).json({ error: "invalid_proposal" });
    if (!vault.get(body.camera_id)) return response.status(404).json({ error: "unknown_camera" });
    if (!learning()) return response.json({ stored: false, reason: "feature_off" });
    try {
      const result = ignoreProposals.propose(body.camera_id, body.zones);
      if (result.stored) audit.record({ action: "ai.ignore_proposal", outcome: "allowed", target: body.camera_id, detail: "proposed" });
      return response.json(result);
    } catch (error) {
      if (error instanceof IgnoreZonesInvalid) return response.status(422).json({ error: "invalid_proposal" });
      throw error;
    }
  });

  app.get("/api/v1/ignore-proposals", requireOperator, (_request, response) => {
    if (!learning()) return response.json({ proposals: [] });
    const proposals = ignoreProposals.list().flatMap(item => {
      const camera = vault.get(item.camera_id);
      return camera ? [{ camera_id: item.camera_id, camera_name: camera.name, zones: item.zones }] : [];
    });
    return response.json({ proposals });
  });

  app.post("/api/v1/ignore-proposals/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id ?? "");
    const decision = (request.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== "accept" && decision !== "reject") return response.status(400).json({ error: "decision is accept or reject" });
    const proposed = learning() ? ignoreProposals.get(id) : undefined;
    if (!proposed) return response.status(404).json({ error: "no proposal waits for that camera" });
    let zones = ignoreZones.get(id);
    if (decision === "accept") {
      const merged = IgnoreProposals.merge(zones, proposed);
      if (!merged) return response.status(400).json({ error: "accepting would pass the limit of areas to ignore" });
      try { zones = ignoreZones.set(id, merged); } catch (error) {
        if (error instanceof IgnoreZonesInvalid) return response.status(400).json({ error: error.message });
        throw error;
      }
    }
    ignoreProposals.decide(id, decision === "accept");
    audit.record({ actor: who(request), action: "ai.ignore_proposal", outcome: "allowed", target: id, detail: decision });
    return response.json({ camera_id: id, decision, zones });
  });
}
