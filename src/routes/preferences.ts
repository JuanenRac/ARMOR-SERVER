/**
 * Per-account interface preferences: language, theme, the saved weather place. Tied to the signed-in
 * user, not the browser, so they travel with the person regardless of which address reached the server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";

export function registerPreferencesRoutes(app: Express, context: AppContext): void {
  const { studioUser, preferences } = context;

  app.get("/api/v1/preferences", (request, response) => {
    const user = studioUser(request);
    if (!user) return response.sendStatus(401);
    return response.json(preferences.get(user.id));
  });

  app.put("/api/v1/preferences", (request, response) => {
    const user = studioUser(request);
    if (!user) return response.sendStatus(401);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return response.json(preferences.update(user.id, { language: body.language, theme: body.theme, weatherPlace: body.weatherPlace }));
    } catch (error) {
      return response.status(400).json({ error: error instanceof Error ? error.message : "invalid" });
    }
  });
}
