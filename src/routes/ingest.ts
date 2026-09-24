/**
 * Status, field-node ingest and arm/disarm. Ingest and control each have their
 * own token; neither is an operator credential.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { parseHealth, parseTelemetry } from "../contracts.js";
import { hasBearer } from "../http/auth.js";

export function registerIngestRoutes(app: Express, context: AppContext, startedAt: number, version: string): void {
  const { config, store, audit } = context;
  const controlLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/healthz", (_request, response) => response.json({ ok: true, service: "armor-server" }));
  app.get("/api/v1/status", (_request, response) => response.json(store.snapshot()));
  app.get("/api/v1/info", (_request, response) => response.json({
    service: "armor-server", version, uptime_s: Math.round((Date.now() - startedAt) / 1000),
    mode: store.snapshot().mode, live_video: Boolean(config.ffmpegPath), mqtt: Boolean(config.mqtt),
  }));

  app.post("/api/v1/telemetry", (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try { return response.status(202).json(store.telemetry(parseTelemetry(request.body))); }
    catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid telemetry" }); }
  });

  app.post("/api/v1/health", (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try { return response.status(202).json(store.health(parseHealth(request.body))); }
    catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid health" }); }
  });

  app.post("/api/v1/control/:mode", controlLimit, (request, response) => {
    if (!hasBearer(request, config.controlToken)) { audit.record({ action: "control.mode", outcome: "denied" }); return response.sendStatus(401); }
    const mode = request.params.mode;
    if (mode !== "arm" && mode !== "disarm") return response.sendStatus(404);
    audit.record({ action: `control.${mode}`, outcome: "allowed" });
    return response.json(store.arm(mode === "arm" ? "armed" : "disarmed"));
  });
}
