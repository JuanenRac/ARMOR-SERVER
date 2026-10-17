/**
 * Alarms (list, acknowledge), automations (list, create, edit, delete, run now), the system mode for a signed-in operator, and the site
 * design kept on the server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Response } from "express";
import type { AppContext } from "../context.js";
import { AutomationError } from "../automations.js";
import { checkDisarm } from "./disarm_gate.js";
import { MAX_SITE_BYTES, SiteConflict, SiteInvalid } from "../site.js";

export function registerAlarmRoutes(app: Express, context: AppContext): void {
  const { alarms, automations, audit, store, site, electrical, devices, requireOperator, studioUser } = context;
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  // The silent alarms (a duress disarm) are seen, acknowledged and deleted by an administrator signed in to Studio, and by nobody else: not an operator, a panel, a viewer or a token.
  const sees = (request: Parameters<typeof studioUser>[0]): { silent: boolean } => ({ silent: studioUser(request)?.role === "admin" });
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const fail = (response: Response, error: unknown) => {
    if (error instanceof AutomationError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };

  // An automation that switches a device that is not a light or a plug (a circuit of the board, a critical circuit) is made by an administrator: it runs with nobody present.
  const needsAdmin = (request: Parameters<typeof studioUser>[0], input: Record<string, unknown>): boolean => {
    if (studioUser(request)?.role === "admin") return false;
    const actions = Array.isArray(input.actions) ? input.actions : [];
    return actions.some(action => typeof action === "object" && action !== null && (action as { type?: unknown }).type === "device" && ((id: unknown) => typeof id === "string" && devices.get(id) !== undefined && devices.get(id)!.risk !== "low")((action as { device_id?: unknown }).device_id));
  };
  const adminOnly = (request: Parameters<typeof studioUser>[0], response: Response, input: Record<string, unknown>, what: string): boolean => {
    if (!needsAdmin(request, input)) return false;
    audit.record({ action: what, outcome: "denied", actor: actor(request), detail: "device that needs an administrator" });
    response.status(403).json({ error: "an automation that switches a circuit is made by an administrator", code: "admin_required" });
    return true;
  };

  // ---- the mode, from Studio ----
  // Disarming asks for the PIN of the signed-in user (always when the user has one; and, with ARMOR_DISARM_PIN=required, a user without one cannot disarm). The duress PIN disarms like
  // the right one and raises a critical alarm that tells the other places, in silence. Three wrong PINs lock the user for a minute, then five, then fifteen, then an hour.
  app.post("/api/v1/mode", requireOperator, (request, response) => {
    const input = body(request), mode = input.mode, user = studioUser(request);
    if (mode !== "armed" && mode !== "disarmed") return response.status(400).json({ error: "the mode is armed or disarmed", code: "invalid_mode" });
    if (mode === "disarmed") {
      const verdict = checkDisarm(context, user, input.pin, actor(request));
      if (!verdict.allow) return response.status(verdict.status).json(verdict.body);
      if (verdict.duress) {
        audit.record({ action: "control.disarm", outcome: "allowed", actor: actor(request), detail: "duress" });
        alarms.raiseDuress(actor(request));
        return response.json(store.arm(mode));
      }
    }
    audit.record({ action: mode === "armed" ? "control.arm" : "control.disarm", outcome: "allowed", actor: actor(request) });
    return response.json(store.arm(mode));
  });

  // ---- alarms ----
  app.get("/api/v1/alarms", requireOperator, (request, response) => response.json({ active: alarms.active(sees(request)), recent: alarms.recent(50, sees(request)) }));
  app.post("/api/v1/alarms/acknowledge", requireOperator, (request, response) => {
    // The wall panel's account proves nobody is standing there (anyone can tap): what it acknowledges stays unverified and a critical alarm keeps being escalated.
    const count = alarms.acknowledgeAll(actor(request), { verified: studioUser(request)?.role !== "panel" });
    audit.record({ action: "alarm.acknowledge", outcome: "allowed", actor: actor(request), detail: `all (${count})` });
    return response.json({ acknowledged: count });
  });
  app.post("/api/v1/alarms/:id/acknowledge", requireOperator, (request, response) => {
    const alarm = alarms.acknowledge(String(request.params.id), actor(request), { ...sees(request), verified: studioUser(request)?.role !== "panel" });
    if (!alarm) return response.status(404).json({ error: "no such alarm", code: "not_found" });
    audit.record({ action: "alarm.acknowledge", outcome: "allowed", actor: actor(request), target: alarm.id });
    return response.json(alarm);
  });
  // Clearing the record is the operator's too (it used to need an administrator and, when the role was missing, silently did nothing): it takes away every alarm
  // somebody has acknowledged - ended or not, since what is being lived with is not news - and leaves the ones nobody has seen.
  app.delete("/api/v1/alarms", requireOperator, (request, response) => {
    const deleted = alarms.clearAcknowledged(sees(request));
    audit.record({ action: "alarm.clear_record", outcome: "allowed", actor: actor(request), detail: String(deleted) });
    return response.json({ deleted });
  });
  app.delete("/api/v1/alarms/:id", requireOperator, (request, response) => {
    // An alarm that is going on and that nobody has seen is not taken off the list (it would be silenced until its cause ended, with nothing in the history): acknowledge it first.
    const target = [...alarms.active(sees(request)), ...alarms.recent(50, sees(request))].find(alarm => alarm.id === String(request.params.id));
    if (target && !target.cleared_at && !target.acknowledged_at) {
      audit.record({ action: "alarm.delete", outcome: "denied", actor: actor(request), target: target.id, detail: `${target.code}: not acknowledged` });
      return response.status(409).json({ error: "acknowledge the alarm before taking it off the list", code: "acknowledge_first" });
    }
    const removed = alarms.remove(String(request.params.id), sees(request));
    if (!removed) return response.status(404).json({ error: "no such alarm", code: "not_found" });
    audit.record({ action: "alarm.delete", outcome: "allowed", actor: actor(request), target: removed.id, detail: removed.code });
    return response.json(removed);
  });

  // ---- automations ----
  app.get("/api/v1/automations", requireOperator, (_request, response) => response.json({ automations: automations.list() }));
  app.post("/api/v1/automations", requireOperator, (request, response) => {
    if (adminOnly(request, response, body(request), "automation.create")) return undefined;
    try {
      const created = automations.create(body(request));
      audit.record({ action: "automation.create", outcome: "allowed", actor: actor(request), target: created.id });
      return response.status(201).json(created);
    } catch (error) { return fail(response, error); }
  });
  app.patch("/api/v1/automations/:id", requireOperator, (request, response) => {
    if (adminOnly(request, response, body(request), "automation.update")) return undefined;
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

  // The versions kept of each design (see site.ts): a list, and one whole, to be taken back by saving it as the current one.
  for (const [prefix, store, key] of [["/api/v1/site", site, "site"], ["/api/v1/electrical/design", electrical, "electrical"]] as const) {
    app.get(`${prefix}/versions`, requireOperator, (_request, response) => response.json({ versions: store.versions() }));
    app.delete(`${prefix}/versions`, requireOperator, (request, response) => {
      const removed = store.deleteVersions();
      audit.record({ action: `${key}.versions.clear`, outcome: "allowed", actor: actor(request), detail: `${removed} versions` });
      return response.json({ removed });
    });
    app.delete(`${prefix}/versions/:id`, requireOperator, (request, response) => {
      const removed = store.deleteVersion(String(request.params.id));
      audit.record({ action: `${key}.version.delete`, outcome: removed ? "allowed" : "failed", actor: actor(request), target: String(request.params.id).slice(0, 60) });
      return removed ? response.sendStatus(204) : response.status(404).json({ error: "no such version", code: "not_found" });
    });
    app.get(`${prefix}/versions/:id`, requireOperator, (request, response) => {
      const doc = store.version(String(request.params.id));
      if (!doc) return response.status(404).json({ error: "no such version", code: "not_found" });
      return response.json({ revision: doc.revision, updated_at: doc.updated_at, updated_by: doc.updated_by, [key]: doc.site });
    });
  }

  // ---- the electrical design (the house's electrical diagram, drawn in Studio's Electrical Designer) ----
  const electricalView = (doc: ReturnType<typeof electrical.get>) => ({ revision: doc.revision, updated_at: doc.updated_at, updated_by: doc.updated_by, electrical: doc.site });
  app.get("/api/v1/electrical/design", requireOperator, (_request, response) => response.json(electricalView(electrical.get())));
  app.put("/api/v1/electrical/design", requireOperator, bigJson, (request, response) => {
    const input = body(request);
    try {
      const saved = electrical.save(input.electrical, input.revision, actor(request));
      audit.record({ action: "electrical.save", outcome: "allowed", actor: actor(request), detail: `revision ${saved.revision}` });
      return response.json({ revision: saved.revision, updated_at: saved.updated_at, updated_by: saved.updated_by });
    } catch (error) {
      if (error instanceof SiteConflict) return response.status(409).json({ error: error.message, code: "conflict", current: electricalView(error.current) });
      if (error instanceof SiteInvalid) return response.status(400).json({ error: error.message, code: "invalid_electrical" });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
