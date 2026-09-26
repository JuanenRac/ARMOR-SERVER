/**
 * Solar inverters and batteries: the messages the gateway nodes send over HTTP (over MQTT they arrive in app.ts), and what Studio and the phone read.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { parseSolarMessage } from "../solar.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function registerSolarRoutes(app: Express, context: AppContext): void {
  const { config, solar, requireOperator } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/v1/solar", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      solar.ingest(parseSolarMessage(request.body));
      return response.status(202).json({ accepted: true });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid solar message" }); }
  });

  app.get("/api/v1/solar", requireOperator, (_request, response) => response.json({ devices: solar.list(), totals: solar.totals() }));

  app.get("/api/v1/solar/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    const device = typeof request.query.device === "string" ? request.query.device : "";
    if (!NODE.test(node) || !DEVICE.test(device)) return response.status(400).json({ error: "node and device are required" });
    const asked = Number(request.query.minutes ?? 60);
    const minutes = Number.isFinite(asked) ? Math.min(1440, Math.max(1, Math.round(asked))) : 60;
    const history = solar.history(node, device, minutes);
    if (!history) return response.status(404).json({ error: "unknown solar device" });
    return response.json({ node_id: node, device, kind: history.kind, minutes, samples: history.samples });
  });
}
