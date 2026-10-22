/**
 * Event history and alert rules. Reading the history and reading or replacing
 * the rules are operator actions; every rules change is audited.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { redactEvent, type ArmorEvent, type ClientKind, type SystemCategory } from "../events.js";
import { agentMatches, CLIENT_KINDS, SYSTEM_CATEGORIES } from "../connections.js";
import type { AlertLevel } from "../store.js";
import { parseRules } from "../rules.js";

const timeParam = (value: unknown): number | undefined | null => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const TYPES = new Set<ArmorEvent["type"]>(["alert", "node", "camera", "mode", "device", "alarm", "connection", "system"]);
const TYPE_NAMES = "alert, node, camera, mode, device, alarm, connection or system";
const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
};

export function registerHistoryRoutes(app: Express, context: AppContext): void {
  const { events, rules, audit, requireOperator, requireAdmin, store, studioUser, studioSessions, connections, users } = context;
  /** Only an administrator signed in to Studio sees the addresses and the user agents; a service with a token is not one. */
  const isAdmin = (request: Parameters<typeof studioUser>[0]): boolean => studioUser(request)?.role === "admin";

  app.get("/api/v1/history", requireOperator, (request, response) => {
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    if (type !== undefined && !TYPES.has(type as ArmorEvent["type"])) return response.status(400).json({ error: `type must be ${TYPE_NAMES}` });
    const category = typeof request.query.category === "string" ? request.query.category : undefined;
    if (category !== undefined && !(SYSTEM_CATEGORIES as readonly string[]).includes(category)) return response.status(400).json({ error: "category must be node, broker, settings, service, update, alarm, backup or batteries" });
    const kind = typeof request.query.kind === "string" ? request.query.kind : undefined;
    if (kind !== undefined && !(CLIENT_KINDS as readonly string[]).includes(kind)) return response.status(400).json({ error: "kind must be studio, android, node, voice or other" });
    const client = typeof request.query.client === "string" ? request.query.client : undefined;
    if (client !== undefined && !/^[0-9a-f]{16}$/.test(client)) return response.status(400).json({ error: "invalid client" });
    const user = typeof request.query.user === "string" ? request.query.user.trim().slice(0, 60) : undefined;
    // A filter that can only match one kind of event says which kind it is about.
    const wanted = type ?? (category ? "system" : kind || client ? "connection" : undefined);
    const node = typeof request.query.node === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(request.query.node) ? request.query.node : undefined;
    if (request.query.node !== undefined && !node) return response.status(400).json({ error: "invalid node" });
    const since = timeParam(request.query.since), until = timeParam(request.query.until);
    if (since === null || until === null) return response.status(400).json({ error: "since and until must be ISO times" });
    const q = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 80) : undefined;
    const level = typeof request.query.level === "string" ? request.query.level : undefined;
    if (level !== undefined && !["normal", "review", "high"].includes(level)) return response.status(400).json({ error: "level must be normal, review or high" });
    // `after=<id>`: what happened after that event, oldest first, so that a client that polls (the phone's service) misses nothing however many events came between two questions.
    const after = positiveInteger(request.query.after);
    const order = after !== undefined || request.query.order === "asc" ? "asc" : "desc";
    const list = events.list({ limit: positiveInteger(request.query.limit), before: after ?? positiveInteger(request.query.before), type: wanted as ArmorEvent["type"] | undefined, node, since, until, q: q || undefined, level: level as AlertLevel | undefined, order,
      category: category as SystemCategory | undefined, kind: kind as ClientKind | undefined, client, user: user || undefined, everything: request.query.all === "1" || Boolean(user) }).map(event => redactEvent(event, isAdmin(request)));
    return response.json({ events: list, next_before: list.length > 0 ? list[list.length - 1].id : null, ...(after !== undefined ? { next_after: list.length > 0 ? list[list.length - 1].id : after } : {}) });
  });

  // Every client the server has seen. The addresses and the user agents are for administrators only.
  app.get("/api/v1/history/connections", requireOperator, (request, response) => {
    const kind = typeof request.query.kind === "string" ? request.query.kind : undefined;
    if (kind !== undefined && !(CLIENT_KINDS as readonly string[]).includes(kind)) return response.status(400).json({ error: "kind must be studio, android, node, voice or other" });
    const user = typeof request.query.user === "string" ? request.query.user.trim().slice(0, 60) : undefined;
    const clients = connections.registry.list(record => (record.user && record.kind !== "voice" && record.kind !== "other"
      ? studioSessions.openFor(users.byName(record.user)?.id, agent => agentMatches(record, agent)) : 0), isAdmin(request), { kind: kind as ClientKind | undefined, user: user || undefined, active: request.query.active === "1" });
    return response.json({ clients });
  });

  app.get("/api/v1/history/summary", requireOperator, (_request, response) => response.json(events.summary()));

  // Removing history is deliberate and permanent, so it needs an explicit confirmation and is audited.
  // Erasing the history is an administrator's: it is the evidence of what happened.
  app.delete("/api/v1/history", requireAdmin, (request, response) => {
    if (request.query.confirm !== "delete") return response.status(400).json({ error: "add confirm=delete to remove history" });
    const scope = request.query.scope;
    const type = typeof request.query.type === "string" ? request.query.type : undefined;
    if (type !== undefined && !TYPES.has(type as ArmorEvent["type"])) return response.status(400).json({ error: `type must be ${TYPE_NAMES}` });
    let before: number | undefined;
    if (scope === "older-than") {
      const days = Number(request.query.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return response.status(400).json({ error: "days must be a whole number from 1 to 3650" });
      before = Date.now() - days * 86_400_000;
    } else if (scope !== "all") return response.status(400).json({ error: "scope must be all or older-than" });
    const result = events.delete({ before, type: type as ArmorEvent["type"] | undefined });
    audit.record({ action: "history.delete", outcome: "allowed", detail: `scope ${String(scope)}${type ? `, type ${type}` : ""}${before !== undefined ? `, days ${String(request.query.days)}` : ""}: ${result.deleted} removed` });
    return response.json(result);
  });

  // Reachability of every configured camera, as seen by the watchdog.
  app.get("/api/v1/camera-status", requireOperator, (_request, response) => response.json({ cameras: context.cameraWatcher.snapshot() }));

  // Decommission a node so it stops appearing (a stale node is otherwise remembered for ever).
  app.delete("/api/v1/nodes/:id", requireOperator, (request, response) => {
    const id = String(request.params.id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return response.status(400).json({ error: "invalid node id" });
    // The id can be a radar node, an electrical node, an alarm panel or a network watcher: all of them are forgotten, with their silence.
    const memory = [store.removeNode(id), context.electricalNodes.remove(id), context.alarmNodes.remove(id), context.networkNodes.remove(id)];
    const remembered = (["electrical", "alarm", "network"] as const).map(kind => context.knownNodes.forget(kind, id));
    // a solar gateway is remembered by gateway and device (`node/device`): taking the node away takes all its devices
    for (const known of context.knownNodes.list()) if (known.kind === "solar" && known.id.startsWith(`${id}/`)) remembered.push(context.knownNodes.forget("solar", known.id));
    const removed = [...memory, ...remembered].some(Boolean);
    context.alarmRules.forgetNode(id);
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
