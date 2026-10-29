/**
 * Push to the phones through Firebase (see ../push_fcm.ts): a phone registers the token of its app with its signed-in session (a viewer too: it is the family's phone that wants the
 * alarms), takes it back when the person signs out, and an administrator asks whether it is on and how many phones are registered. It is only on when the installation has its own service account.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { FcmFull, FcmInvalid } from "../push_fcm.js";

export function registerPushRoutes(app: Express, context: AppContext): void {
  const { fcmDevices, requireOperator, requireAdmin, audit, studioUser } = context;
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const who = (request: Parameters<typeof studioUser>[0]): string | undefined => studioUser(request)?.username;
  const tokenOf = (body: unknown): unknown => (typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined);

  app.get("/api/v1/push/status", requireAdmin, (_request, response) => response.json({ enabled: context.fcmEnabled, devices: fcmDevices.count() }));

  app.post("/api/v1/push/register", requireOperator, limit, (request, response) => {
    if (!context.fcmEnabled) return response.status(409).json({ error: "push_off" });
    try {
      const body = request.body as { language?: unknown } | undefined;
      const added = fcmDevices.add(tokenOf(request.body), who(request) ?? "", typeof body === "object" && body !== null ? body.language : undefined);
      if (added) audit.record({ actor: who(request), action: "push.register", outcome: "allowed", target: "a phone" });
      return response.status(added ? 201 : 200).json({ registered: true, devices: fcmDevices.count() });
    } catch (error) {
      if (error instanceof FcmFull) return response.status(409).json({ error: "push_full" });
      if (error instanceof FcmInvalid) return response.status(400).json({ error: "invalid_token" });
      throw error;
    }
  });

  // DELETE is the proper verb, but a phone's HTTP stack may not send a body with it: the same thing as a POST.
  const unregister = (request: Request, response: Response): Response => {
    const token = tokenOf(request.body);
    const removed = typeof token === "string" && fcmDevices.remove(token);
    if (removed) audit.record({ actor: who(request), action: "push.unregister", outcome: "allowed", target: "a phone" });
    return response.json({ registered: false, devices: fcmDevices.count() });
  };
  app.delete("/api/v1/push/register", requireOperator, limit, (request, response) => unregister(request, response));
  app.post("/api/v1/push/unregister", requireOperator, limit, (request, response) => unregister(request, response));
}
