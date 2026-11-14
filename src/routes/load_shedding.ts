/**
 * Load shedding (see ../load_shedding.ts):
 *   GET /api/v1/electrical/load-shedding   whether the option is on, the settings, the devices shed now, the grid draw and the log (operators and administrators)
 *   PUT /api/v1/electrical/load-shedding   the settings (an administrator; a new proof of identity from outside the house)
 * The settings can be saved while the option `electrical.load_shedding` is off; nothing is shed until it is on.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import type { AppContext } from "../context.js";
import { SheddingInvalid } from "../load_shedding.js";

export function registerLoadSheddingRoutes(app: Express, context: AppContext): void {
  const { loadShedding, requireOperator, requireAdmin, audit, studioUser } = context;
  const actor = (request: Request): string | undefined => studioUser(request)?.username;

  app.get("/api/v1/electrical/load-shedding", requireOperator, (_request, response) => {
    response.set("Cache-Control", "private, no-store");
    return response.json(loadShedding.status());
  });

  app.put("/api/v1/electrical/load-shedding", requireAdmin, context.requireElevated, (request, response) => {
    try {
      const settings = loadShedding.configure(request.body);
      audit.record({ action: "electrical.load_shedding.configure", outcome: "allowed", actor: actor(request), detail: `limit ${settings.limit_w} W, restore ${settings.restore_w} W, ${settings.loads.length} loads` });
      return response.json(loadShedding.status());
    } catch (error) {
      if (error instanceof SheddingInvalid) {
        audit.record({ action: "electrical.load_shedding.configure", outcome: "denied", actor: actor(request), detail: error.code });
        return response.status(422).json({ error: error.message, code: error.code });
      }
      return response.status(500).json({ error: "internal error" });
    }
  });
}
