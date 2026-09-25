/**
 * Event history and alert rules. Reading the history and reading or replacing
 * the rules are operator actions; every rules change is audited.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import type { ArmorEvent } from "../events.js";
import { parseRules } from "../rules.js";

const TYPES = new Set<ArmorEvent["type"]>(["alert", "node", "camera", "mode"]);
const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
};

export function registerHistoryRoutes(app: Express, context: AppContext): void {
  const { events, rules, audit, requireOperator, store } = context;

  app.get("/api/v1/history", requireOperator, (request, response) => {
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    if (type !== undefined && !TYPES.has(type as ArmorEvent["type"])) return response.status(400).json({ error: "type must be alert, node, camera or mode" });
    const node = typeof request.query.node === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(request.query.node) ? request.query.node : undefined;
    if (request.query.node !== undefined && !node) return response.status(400).json({ error: "invalid node" });
    const list = events.list({ limit: positiveInteger(request.query.limit), before: positiveInteger(request.query.before), type: type as ArmorEvent["type"] | undefined, node });
    return response.json({ events: list, next_before: list.length > 0 ? list[list.length - 1].id : null });
  });

  // Reachability of every configured camera, as seen by the watchdog.
  app.get("/api/v1/camera-status", requireOperator, (_request, response) => response.json({ cameras: context.cameraWatcher.snapshot() }));

  // Decommission a node so it stops appearing (a stale node is otherwise remembered for ever).
  app.delete("/api/v1/nodes/:id", requireOperator, (request, response) => {
    const id = String(request.params.id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return response.status(400).json({ error: "invalid node id" });
    const removed = store.removeNode(id);
    audit.record({ action: "node.remove", outcome: removed ? "allowed" : "failed", target: id });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "unknown node" });
  });

  app.get("/api/v1/rules", requireOperator, (_request, response) => response.json(rules.get()));

  app.put("/api/v1/rules", requireOperator, (request, response) => {
    const parsed = parseRules(request.body);
    if (!parsed) {
      audit.record({ action: "rules.update", outcome: "denied", detail: "invalid rules" });
      return response.status(400).json({ error: "invalid rules" });
    }
    try { rules.set(parsed); }
    catch { audit.record({ action: "rules.update", outcome: "failed" }); return response.status(500).json({ error: "rules could not be saved" }); }
    audit.record({ action: "rules.update", outcome: "allowed", detail: `${parsed.zones.length} zones, dwell ${parsed.dwell_ms} ms` });
    // The new rules apply from the next observation; re-evaluate what is already known.
    store.sweep();
    return response.json(parsed);
  });
}
