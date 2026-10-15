/**
 * The alarm design: the house's alarm drawn in Studio's Alarm Designer (the panels, the sensors of the doors and windows, the sirens, the keypads and how they are joined). It is kept
 * the way the electrical and network drawings are: one document with a revision, so two browsers never overwrite each other silently, and the earlier versions are kept. It is a drawing:
 * nothing here arms, disarms or sounds anything.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express } from "express";
import type { AppContext } from "../context.js";
import { MAX_SITE_BYTES, SiteConflict, SiteInvalid } from "../site.js";

export function registerAlarmDesignRoutes(app: Express, context: AppContext): void {
  const { alarmDesign, audit, requireOperator, studioUser } = context;
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const bigJson = express.json({ limit: MAX_SITE_BYTES + 4096, type: "application/json" });
  const view = (doc: ReturnType<typeof alarmDesign.get>) => ({ revision: doc.revision, updated_at: doc.updated_at, updated_by: doc.updated_by, alarm_design: doc.site });

  app.get("/api/v1/alarm/design", requireOperator, (_request, response) => response.json(view(alarmDesign.get())));
  app.get("/api/v1/alarm/design/versions", requireOperator, (_request, response) => response.json({ versions: alarmDesign.versions() }));
  app.get("/api/v1/alarm/design/versions/:id", requireOperator, (request, response) => {
    const doc = alarmDesign.version(String(request.params.id));
    if (!doc) return response.status(404).json({ error: "no such version", code: "not_found" });
    return response.json(view(doc));
  });
  app.delete("/api/v1/alarm/design/versions", requireOperator, (request, response) => {
    const removed = alarmDesign.deleteVersions();
    audit.record({ action: "alarm_design.versions.clear", outcome: "allowed", actor: actor(request), detail: `${removed} versions` });
    return response.json({ removed });
  });
  app.delete("/api/v1/alarm/design/versions/:id", requireOperator, (request, response) => {
    const removed = alarmDesign.deleteVersion(String(request.params.id));
    audit.record({ action: "alarm_design.version.delete", outcome: removed ? "allowed" : "failed", actor: actor(request), target: String(request.params.id).slice(0, 60) });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "no such version", code: "not_found" });
  });
  app.put("/api/v1/alarm/design", requireOperator, bigJson, (request, response) => {
    const input = body(request);
    try {
      const saved = alarmDesign.save(input.alarm_design, input.revision, actor(request));
      audit.record({ action: "alarm_design.save", outcome: "allowed", actor: actor(request), detail: `revision ${saved.revision}` });
      return response.json({ revision: saved.revision, updated_at: saved.updated_at, updated_by: saved.updated_by });
    } catch (error) {
      if (error instanceof SiteConflict) return response.status(409).json({ error: error.message, code: "conflict", current: view(error.current) });
      if (error instanceof SiteInvalid) return response.status(400).json({ error: error.message, code: "invalid_alarm_design" });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
