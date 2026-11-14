/**
 * The presence by person, behind the security option `presence.by_user` (off by default: every route here answers 404 as if it did not exist).
 *   PUT /api/v1/presence/me   the phone of a signed-in person says "home" or "away" (only that word; the position of the phone never reaches the server)
 *   GET /api/v1/presence/me   the last fresh word of that person
 *   GET /api/v1/presence      an administrator: the people with a fresh word and the sum that the automations with a presence trigger follow
 * When the sum becomes `everyone_away` or `someone_home`, the automations with that presence trigger run. Only the fact that a word was told goes to the audit trail, not the place.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { isPresenceWord } from "../presence.js";

export function registerPresenceRoutes(app: Express, context: AppContext): void {
  const { presence, automations, audit, requireOperator, requireAdmin, studioUser, securitySettings, users } = context;
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const off = () => !securitySettings.get("presence.by_user");

  app.get("/api/v1/presence/me", requireOperator, (request, response) => {
    if (off()) return response.status(404).json({ error: "not found" });
    const user = studioUser(request);
    if (!user) return response.status(403).json({ error: "gateway_only" });
    return response.json(presence.mine(user.id));
  });

  app.put("/api/v1/presence/me", requireOperator, limit, (request, response) => {
    if (off()) return response.status(404).json({ error: "not found" });
    const user = studioUser(request);
    if (!user) return response.status(403).json({ error: "gateway_only" });
    const state = (request.body as { state?: unknown } | undefined)?.state;
    if (!isPresenceWord(state)) return response.status(400).json({ error: "state is home or away", code: "invalid_state" });
    const { before, after } = presence.set(user.id, state);
    audit.record({ action: "presence.word", outcome: "allowed", actor: user.username, detail: state });
    if (after !== before && (after === "everyone_away" || after === "someone_home")) automations.handlePresence(after);
    return response.json(presence.mine(user.id));
  });

  app.get("/api/v1/presence", requireAdmin, (_request, response) => {
    if (off()) return response.status(404).json({ error: "not found" });
    return response.json(presence.summary(id => users.get(id)?.username));
  });
}
