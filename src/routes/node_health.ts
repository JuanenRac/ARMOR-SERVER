/**
 * The health of the nodes, in the same words for every family: a node sends its report to POST /api/v1/node-health (or over MQTT to armor/health/{node}); an operator reads them all,
 * one node with its history and its restarts, and an administrator can forget a node that was taken away. Reading never moves anything; the warnings the reports raise are in the alarm
 * centre (see ../node_health.ts for what is judged and how).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { forwardCompatible } from "../contracts.js";
import { stampOf } from "../mqtt.js";
import { ingestCaller } from "../http/node_token.js";
import { HEALTH_LEVELS, parseNodeHealth, type HealthFamily, type NodeHealthView } from "../node_health.js";
import { withoutSensorAddresses } from "../node_diag_contract.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerNodeHealthRoutes(app: Express, context: AppContext): void {
  const { config, nodeHealth, requireOperator, requireAdmin, audit, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/v1/node-health", ingestLimit, (request, response) => {
    if (!ingestCaller(request, config.ingestToken, config.ingestStrict, (request.body as { node_id?: unknown } | undefined)?.node_id)) return response.sendStatus(401);
    try {
      const { value, ignored } = forwardCompatible(() => parseNodeHealth(request.body));
      nodeHealth.ingest({ ...value, timestamp_ms: stampOf(value.timestamp_ms, Date.now()) });
      context.ingestLog.ok(`http:health/${value.node_id}`, ignored);
      return response.status(202).json({ accepted: true, ...(ignored.length ? { ignored } : {}) });
    } catch (error) {
      const why = error instanceof Error ? error.message : "invalid node health";
      context.ingestLog.rejected("http:health", why, JSON.stringify(request.body ?? null));
      return response.status(400).json({ error: why });
    }
  });

  // Every node that has reported, the sums, the levels the server judges by, and the nodes that are known (they have spoken in their own way) but have sent no report yet - an older firmware.
  // The Bluetooth address of a sensor is for administrators: everybody else reads the report without it.
  const isAdmin = (request: Parameters<typeof studioUser>[0]): boolean => studioUser(request)?.role === "admin";
  const shown = <T extends NodeHealthView>(view: T, admin: boolean): T => (admin ? view : { ...view, report: withoutSensorAddresses(view.report) });
  app.get("/api/v1/node-health", requireOperator, (request, response) => {
    const admin = isAdmin(request);
    const nodes = nodeHealth.list().map(view => shown(view, admin));
    const reported = new Set(nodes.map(node => node.node_id));
    const known = new Map<string, HealthFamily>();
    for (const id of Object.keys(context.store.snapshot().nodes)) known.set(id, "radar");
    for (const item of context.solar.list()) known.set(item.node_id, "solar");
    for (const item of context.electricalNodes.list()) known.set(item.node_id, "electrical");
    for (const item of context.alarmNodes.list()) known.set(item.node_id, "alarm");
    for (const panel of context.store.wallPanels()) known.set(panel.id, "hmi");
    const waiting = [...known.entries()].filter(([id]) => !reported.has(id)).map(([node_id, family]) => ({ node_id, family })).sort((a, b) => a.node_id.localeCompare(b.node_id));
    return response.json({ nodes, waiting, totals: nodeHealth.totals(), levels: HEALTH_LEVELS });
  });

  // The newest events of the perimeter engine of the radar nodes, newest first (a node's own, or all): GET /api/v1/radar/events?node=radar-1&limit=50.
  app.get("/api/v1/radar/events", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : undefined;
    if (node !== undefined && !NODE.test(node)) return response.status(400).json({ error: "that is not the name of a node", code: "invalid_request" });
    const asked = Number(request.query.limit);
    const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, 500) : 100;
    return response.json({ events: context.radarEvents.list(node, limit), nodes: context.radarEvents.nodes() });
  });

  app.get("/api/v1/node-health/:id", requireOperator, (request, response) => {
    const id = String(request.params.id);
    const detail = NODE.test(id) ? nodeHealth.get(id) : undefined;
    return detail ? response.json(shown(detail, isAdmin(request))) : response.status(404).json({ error: "no such node", code: "not_found" });
  });

  app.delete("/api/v1/node-health/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    const removed = NODE.test(id) && nodeHealth.remove(id);
    audit.record({ action: "node_health.forget", outcome: removed ? "allowed" : "failed", actor: studioUser(request)?.username ?? "administrator", target: id.slice(0, 64) });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "no such node", code: "not_found" });
  });
}
