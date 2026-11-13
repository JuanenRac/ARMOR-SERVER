/**
 * The review timeline of the vision service (see ../vision_timeline.ts):
 *
 *   GET    /api/v1/vision/timeline         the entries, newest first (operators and administrators), filtered by since, level, camera_id and limit
 *   DELETE /api/v1/vision/timeline         delete every entry (an administrator)
 *   DELETE /api/v1/vision/timeline/:id     delete one entry (an administrator)
 *
 * While the option `vision.timeline` is off the list answers `{ enabled: false, days, items: [] }` and nothing is kept. The evidence files are not touched: they follow the retention of the evidence library.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { TIMELINE_ID, TimelineQueryInvalid, parseTimelineQuery } from "../vision_timeline.js";

export function registerVisionTimelineRoutes(app: Express, context: AppContext): void {
  const { visionTimeline, requireOperator, requireAdmin, audit, studioUser } = context;
  const actor = (request: Parameters<typeof studioUser>[0]): string | undefined => studioUser(request)?.username;

  app.get("/api/v1/vision/timeline", requireOperator, (request, response) => {
    const user = studioUser(request);
    if (user && user.role !== "admin" && user.role !== "operator") return response.status(403).json({ error: "only an administrator or an operator can ask for this" });
    response.set("Cache-Control", "private, no-store");
    if (!visionTimeline.enabled()) return response.json({ enabled: false, days: visionTimeline.days(), items: [] });
    try {
      return response.json({ enabled: true, days: visionTimeline.days(), items: visionTimeline.list(parseTimelineQuery(request.query as Record<string, unknown>)) });
    } catch (error) {
      if (error instanceof TimelineQueryInvalid) return response.status(422).json({ error: error.message, code: "invalid_request" });
      throw error;
    }
  });

  app.delete("/api/v1/vision/timeline", requireAdmin, (request, response) => {
    const deleted = visionTimeline.clear();
    audit.record({ action: "vision.timeline", outcome: "allowed", actor: actor(request), target: "all", detail: `${deleted} deleted` });
    response.json({ deleted });
  });

  app.delete("/api/v1/vision/timeline/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    if (!TIMELINE_ID.test(id) || !visionTimeline.remove(id)) return response.status(404).json({ error: "unknown entry", code: "not_found" });
    audit.record({ action: "vision.timeline", outcome: "allowed", actor: actor(request), target: id, detail: "deleted" });
    response.json({ deleted: 1 });
  });
}
