/**
 * Status, field-node ingest and arm/disarm. Ingest and control each have their
 * own token; neither is an operator credential.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { forwardCompatible, parseHealth, parseTelemetry } from "../contracts.js";
import { stampOf } from "../mqtt.js";
import { hasBearer } from "../http/auth.js";
import { ingestCaller } from "../http/node_token.js";

export function registerIngestRoutes(app: Express, context: AppContext, startedAt: number, version: string): void {
  const { config, store, audit, requireOperator, operatorAuthorized } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });
  const controlLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/healthz", (_request, response) => response.json({ ok: true, service: "armor-server" }));
  // The perimeter state (armed or not, where the targets are) is for operators only: a stranger on the
  // network must not learn whether the system is armed.
  app.get("/api/v1/status", requireOperator, (_request, response) => response.json(store.snapshot()));
  // The exact version and how long the server has been up tell a stranger which known flaws to try and when it last restarted (after a power cut): they are for a signed-in client.
  app.get("/api/v1/info", (request, response) => response.json({
    service: "armor-server",
    ...(operatorAuthorized(request) || context.studioUser(request) ? { version, uptime_s: Math.round((Date.now() - startedAt) / 1000) } : {}),
    ...(operatorAuthorized(request) ? { mode: store.snapshot().mode, live_video: Boolean(config.ffmpegPath), mqtt: Boolean(config.mqtt) } : {}),
  }));

  // A node without a clock (it has not reached an NTP server, or it restarted) counts its time from zero: over MQTT the server already gives such a message the time it arrived, and over HTTP
  // it did not, so a node that restarted had its messages taken for old ones and ignored until its counter passed the old one.
  const stamped = <T extends { timestamp_ms: number }>(message: T): T => ({ ...message, timestamp_ms: stampOf(message.timestamp_ms, Date.now()) });

  app.post("/api/v1/telemetry", ingestLimit, (request, response) => {
    if (!ingestCaller(request, config.ingestToken, config.ingestStrict, (request.body as { node_id?: unknown } | undefined)?.node_id)) return response.sendStatus(401);
    // The answer is deliberately minimal: a field node's token must not reveal the rest of the perimeter.
    try {
      // As over MQTT, a field this server does not know yet is ignored and said, not a reason to lose the message (a newer node, an older server).
      const { value, ignored } = forwardCompatible(() => parseTelemetry(request.body));
      return response.status(202).json({ accepted: true, revision: store.telemetry(stamped(value)).revision, ...(ignored.length ? { ignored } : {}) });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid telemetry" }); }
  });

  app.post("/api/v1/health", ingestLimit, (request, response) => {
    if (!ingestCaller(request, config.ingestToken, config.ingestStrict, (request.body as { node_id?: unknown } | undefined)?.node_id)) return response.sendStatus(401);
    try {
      const { value, ignored } = forwardCompatible(() => parseHealth(request.body));
      return response.status(202).json({ accepted: true, revision: store.health(stamped(value)).revision, ...(ignored.length ? { ignored } : {}) });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid health" }); }
  });

  app.post("/api/v1/control/:mode", controlLimit, (request, response) => {
    if (!hasBearer(request, config.controlToken)) { audit.record({ action: "control.mode", outcome: "denied" }); return response.sendStatus(401); }
    const mode = request.params.mode;
    if (mode !== "arm" && mode !== "disarm") return response.sendStatus(404);
    // This route knows no person and takes no PIN: with the PIN required for disarming it is closed to disarm unless the installation asked for it (ARMOR_CONTROL_DISARM=1).
    if (mode === "disarm" && config.disarmPinRequired && !config.controlDisarm) {
      audit.record({ action: "control.disarm", outcome: "denied", detail: "the PIN is required" });
      return response.status(403).json({ error: "disarming with the control token is off while the PIN is required; disarm from Studio, the phone or the wall panel", code: "pin_required" });
    }
    audit.record({ action: `control.${mode}`, outcome: "allowed" });
    return response.json(store.arm(mode === "arm" ? "armed" : "disarmed"));
  });
}
