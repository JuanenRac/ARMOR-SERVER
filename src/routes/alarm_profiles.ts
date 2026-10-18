/**
 * The arming profiles (Away, Home, Night, the owner's own): anybody signed in reads them, an administrator replaces the list. A profile is chosen when arming a panel
 * (POST /api/v1/alarm/command with `profile`, see alarm.ts); editing one arms nothing and changes nothing on a panel that is already armed.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { ProfilesConflict, ProfilesInvalid, MAX_PROFILES } from "../arm_profiles.js";

export function registerAlarmProfileRoutes(app: Express, context: AppContext): void {
  const { armProfiles, audit, requireOperator, requireAdmin, studioUser } = context;

  app.get("/api/v1/alarm/profiles", requireOperator, (_request, response) => response.json({ ...armProfiles.get(), max: MAX_PROFILES }));

  // { profiles: [...], revision } replaces the whole list; the revision is the one the editor read (409 with the current list when somebody changed it meanwhile).
  app.put("/api/v1/alarm/profiles", requireAdmin, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const actor = studioUser(request)?.username ?? "administrator";
    try {
      const saved = armProfiles.replace(body.profiles, body.revision, actor);
      audit.record({ action: "alarm_profiles.save", outcome: "allowed", actor, detail: `revision ${saved.revision}, ${saved.profiles.length} profiles` });
      return response.json({ ...saved, max: MAX_PROFILES });
    } catch (error) {
      if (error instanceof ProfilesConflict) return response.status(409).json({ error: error.message, code: "conflict", current: error.current });
      if (error instanceof ProfilesInvalid) {
        audit.record({ action: "alarm_profiles.save", outcome: "denied", actor, detail: error.message.slice(0, 120) });
        return response.status(400).json({ error: error.message, code: "invalid_profiles" });
      }
      return response.status(500).json({ error: "internal error" });
    }
  });
}
