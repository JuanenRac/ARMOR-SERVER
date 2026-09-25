/**
 * Alarms (list, acknowledge), automations (list, create, edit, delete, run now), the system mode for a signed-in operator, and the site
 * design kept on the server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Response } from "express";
import type { AppContext } from "../context.js";
import { AutomationError } from "../automations.js";
import { MAX_SITE_BYTES, SiteConflict, SiteInvalid } from "../site.js";

export function registerAlarmRoutes(app: Express, context: AppContext): void {
  const { alarms, automations, audit, store, site, requireOperator, studioUser } = context;
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const fail = (response: Response, error: unknown) => {
    if (error instanceof AutomationError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };

  // ---- the mode, from Studio ----
  app.post("/api/v1/mode", requireOperator, (request, response) => {
    const mode = body(request).mode;
    if (mode !== "armed" && mode !== "disarmed") return response.status(400).json({ error: "the mode is armed or disarmed", code: "invalid_mode" });
    audit.record({ action: mode === "armed" ? "control.arm" : "control.disarm", outcome: "allowed", actor: actor(request) });
    return response.json(store.arm(mode));
  });

  // ---- alarms ----
  app.get("/api/v1/alarms", requireOperator, (_request, response) => response.json({ active: alarms.active(), recent: alarms.recent() }));
  app.post("/api/v1/alarms/acknowledge", requireOperator, (request, response) => {
    const count = alarms.acknowledgeAll(actor(request));
    audit.record({ action: "alarm.acknowledge", outcome: "allowed", actor: actor(request), detail: `all (${count})` });
    return response.json({ acknowledged: count });
  });
  app.post("/api/v1/alarms/:id/acknowledge", requireOperator, (request, response) => {
    const alarm = alarms.acknowledge(String(request.params.id), actor(request));
    if (!alarm) return response.status(404).json({ error: "no such alarm", code: "not_found" });
    audit.record({ action: "alarm.acknowledge", outcome: "allowed", actor: actor(request), target: alarm.id });
    return response.json(alarm);
  });
  app.delete("/api/v1/alarms", context.requireAdmin, (request, response) => {
    const deleted = alarms.deleteRecent();
    audit.record({ action: "alarm.clear_record", outcome: "allowed", actor: actor(request), detail: String(deleted) });
    return response.json({ deleted });
  });

  // ---- automations ----
  app.get("/api/v1/automations", requireOperator, (_request, response) => response.json({ automations: automations.list() }));
  app.post("/api/v1/automations", requireOperator, (request, response) => {
    try {
      const created = automations.create(body(request));
      audit.record({ action: "automation.create", outcome: "allowed", actor: actor(request), target: created.id });
      return response.status(201).json(created);
    } catch (error) { return fail(response, error); }
  });
  app.patch("/api/v1/automations/:id", requireOperator, (request, response) => {
    try {
      const updated = automations.update(String(request.params.id), body(request));
      audit.record({ action: "automation.update", outcome: "allowed", actor: actor(request), target: updated.id });
      return response.json(updated);
    } catch (error) { return fail(response, error); }
  });
  app.delete("/api/v1/automations/:id", requireOperator, (request, response) => {
    try {
      automations.remove(String(request.params.id));
      audit.record({ action: "automation.delete", outcome: "allowed", actor: actor(request), target: String(request.params.id) });
      return response.sendStatus(204);
    } catch (error) { return fail(response, error); }
  });
  app.post("/api/v1/automations/:id/run", requireOperator, async (request, response) => {
    try {
      audit.record({ action: "automation.run_now", outcome: "allowed", actor: actor(request), target: String(request.params.id) });
      await automations.runNow(String(request.params.id));
      return response.json({ ok: true });
    } catch (error) { return fail(response, error); }
  });

  // ---- the site design ----
  // The design can be bigger than the general 64 kB request limit, so this route reads its own body.
  const bigJson = express.json({ limit: MAX_SITE_BYTES + 4096, type: "application/json" });
  app.get("/api/v1/site", requireOperator, (_request, response) => response.json(site.get()));
  app.put("/api/v1/site", requireOperator, bigJson, (request, response) => {
    const input = body(request);
    try {
      const saved = site.save(input.site, input.revision, actor(request));
      return response.json({ revision: saved.revision, updated_at: saved.updated_at, updated_by: saved.updated_by });
    } catch (error) {
      if (error instanceof SiteConflict) return response.status(409).json({ error: "the site was changed by someone else", code: "conflict", current: error.current });
      if (error instanceof SiteInvalid) return response.status(400).json({ error: error.message, code: "invalid_site" });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
