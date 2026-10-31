/**
 * The arming modes (away, home, night): anybody signed in reads what is in force and how each mode is defined, an administrator replaces the definitions and the timetable. Changing the
 * mode itself is POST /api/v1/mode (routes/alarms.ts), with the same PIN, lockout and audit as arming and disarming. Editing a definition arms nothing and changes nothing in the mode that
 * is in force; the definitions can be prepared while the modes are still turned off (setting alarm.arming_modes).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { MAX_SCHEDULE, ModesConflict, ModesInvalid } from "../arming_modes.js";

export function registerAlarmModeRoutes(app: Express, context: AppContext): void {
  const { armingModes, modePanelSync, audit, securitySettings, requireOperator, requireAdmin, studioUser } = context;

  const view = () => {
    const stored = armingModes.get();
    return {
      enabled: armingModes.enabled, current: armingModes.current(), available: armingModes.available(), unassigned: armingModes.unassigned(),
      downgrade_pin_required: securitySettings.get("alarm.mode_downgrade_pin") === "required", schedule_enabled: securitySettings.get("alarm.mode_schedule"),
      schedule_may_lower: securitySettings.get("alarm.mode_schedule_lowers"), max_schedule: MAX_SCHEDULE,
      panel_sync_enabled: modePanelSync.enabled, ...(modePanelSync.view() ? { panel_sync: modePanelSync.view() } : {}),
      revision: stored.revision, updated_at: stored.updated_at, updated_by: stored.updated_by, modes: stored.modes, schedule: stored.schedule,
    };
  };

  app.get("/api/v1/alarm/modes", requireOperator, (_request, response) => response.json(view()));

  // { modes: { away, home, night }, schedule: [...], revision } replaces the definitions and the timetable as a whole; the revision is the one the editor read (409 with the current ones when somebody changed them meanwhile).
  app.put("/api/v1/alarm/modes", requireAdmin, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const actor = studioUser(request)?.username ?? "administrator";
    try {
      const saved = armingModes.replace({ modes: body.modes, ...("schedule" in body ? { schedule: body.schedule } : {}) }, body.revision, actor);
      audit.record({ action: "arming_modes.save", outcome: "allowed", actor, detail: `revision ${saved.revision}, ${saved.schedule.length} timetable entries` });
      return response.json(view());
    } catch (error) {
      if (error instanceof ModesConflict) return response.status(409).json({ error: error.message, code: "conflict", current: error.current });
      if (error instanceof ModesInvalid) {
        audit.record({ action: "arming_modes.save", outcome: "denied", actor, detail: error.message.slice(0, 120) });
        return response.status(400).json({ error: error.message, code: "invalid_modes" });
      }
      return response.status(500).json({ error: "internal error" });
    }
  });
}
