/**
 * Sessions: the Studio sign-in (human login) and the operator-token exchange
 * used by service automation. Both hand out an HttpOnly cookie, never a body token.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer, secureEquals } from "../http/auth.js";

export function registerSessionRoutes(app: Express, context: AppContext): void {
  const { config, audit, studioSessions, operatorSessions, requireOperator } = context;
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many Studio login attempts" } });

  app.get("/api/v1/studio/session", (request, response) => response.json({ authenticated: studioSessions.has(request) }));

  app.post("/api/v1/studio/session", loginLimit, (request, response) => {
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    // Check both values before answering so the response time never reveals which was wrong.
    const userOk = secureEquals(username, config.studioUsername);
    const passwordOk = secureEquals(password, config.studioPassword);
    if (!userOk || !passwordOk) {
      audit.record({ action: "studio.login", outcome: "denied", actor: username.slice(0, 40) });
      return response.sendStatus(401);
    }
    const expiresAt = studioSessions.open(response);
    audit.record({ action: "studio.login", outcome: "allowed", actor: username });
    return response.status(201).json({ expiresAt });
  });

  app.delete("/api/v1/studio/session", (request, response) => {
    studioSessions.close(request, response);
    return response.sendStatus(204);
  });

  app.post("/api/v1/operator/session", (request, response) => {
    if (!hasBearer(request, config.operatorToken)) {
      audit.record({ action: "operator.session", outcome: "denied" });
      return response.sendStatus(401);
    }
    const expiresAt = operatorSessions.open(response);
    audit.record({ action: "operator.session", outcome: "allowed" });
    return response.status(201).json({ expiresAt });
  });

  app.delete("/api/v1/operator/session", requireOperator, (request, response) => {
    operatorSessions.close(request, response);
    return response.sendStatus(204);
  });
}
