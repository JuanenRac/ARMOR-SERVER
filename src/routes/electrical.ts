/**
 * The readings of the ARMOR-ELECTRICAL nodes: the messages the nodes send over HTTP (over MQTT they arrive in app.ts), and what Studio reads. Reading only:
 * there is no route here that sends anything to a node.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { parseElectricalMessage } from "../electrical.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function registerElectricalRoutes(app: Express, context: AppContext): void {
  const { config, electricalNodes, requireOperator } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/v1/electrical/readings", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      electricalNodes.ingest(parseElectricalMessage(request.body));
      return response.status(202).json({ accepted: true });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid electrical message" }); }
  });

  app.get("/api/v1/electrical/readings", requireOperator, (_request, response) => response.json({ nodes: electricalNodes.list(), totals: electricalNodes.totals() }));

  app.get("/api/v1/electrical/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    const channel = typeof request.query.channel === "string" ? request.query.channel : "";
    if (!NODE.test(node) || !CHANNEL.test(channel)) return response.status(400).json({ error: "node and channel are required" });
    const asked = Number(request.query.minutes ?? 60);
    const minutes = Number.isFinite(asked) ? Math.min(1440, Math.max(1, Math.round(asked))) : 60;
    const samples = electricalNodes.history(node, channel, minutes);
    if (!samples) return response.status(404).json({ error: "unknown electrical channel" });
    return response.json({ node_id: node, channel, minutes, samples });
  });
}
