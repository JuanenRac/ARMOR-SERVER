/**
 * Where the alarms go, and a way to try it: Telegram and Home Assistant are set up in the settings file of the server (Configuration > Settings files, `armor.env`); this says
 * which places are configured (never their secrets) and sends a test message to them, so a wrong token or a wrong address shows up now and not on the night of an alarm.
 * Administrators only; the test is in the audit trail.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";

export function registerNotificationRoutes(app: Express, context: AppContext): void {
  const { notifier, store, requireAdmin } = context;
  const limit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/api/v1/admin/notifications", requireAdmin, (_request, response) => response.json(notifier.status()));

  app.post("/api/v1/admin/notifications/test", requireAdmin, limit, async (request, response) => {
    const only = typeof request.body?.channel === "string" ? request.body.channel : undefined;
    if (only !== undefined && !["webhook", "mqtt", "telegram", "homeassistant"].includes(only)) return response.status(422).json({ error: "unknown_channel" });
    const results = await notifier.test(store.snapshot().mode, only);
    if (results.length === 0) return response.status(409).json({ error: "nothing_configured", results });
    return response.json({ results });
  });
}
