/**
 * The hidden panic gesture of the apps (a long press on the logo, or five quick touches): it raises the silent duress alarm of the signed-in person, as the duress PIN does (see alarms.ts):
 * nothing shows on the phone or the panel, the mode is not touched, and the answer is the same `{ ok: true }` whether an alarm was raised or the quiet time of that person had not ended.
 * While the option `client.panic_gesture` is off (the default) the route answers 404, as if it did not exist, so the apps do not offer the gesture and a probe learns nothing. Only a person with
 * a session of their own can do it (not a service token). The quiet time is `voice.panic_cooldown_s`, per person; only the fact is written to the audit trail.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";

export function registerPanicGestureRoutes(app: Express, context: AppContext): void {
  const { alarms, audit, requireOperator, studioUser, securitySettings } = context;
  /** When each person's gesture last raised the alarm (memory only: a restart forgets it, which can only allow one more alarm). */
  const last = new Map<string, number>();
  const limit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/v1/alarm/panic-gesture", requireOperator, limit, (request, response) => {
    if (!securitySettings.get("client.panic_gesture")) return response.status(404).json({ error: "not found" });
    const user = studioUser(request);
    if (!user) return response.status(403).json({ error: "gateway_only" });
    const now = Date.now(), quiet = securitySettings.get("voice.panic_cooldown_s") * 1000;
    if (now - (last.get(user.id) ?? 0) >= quiet) {
      last.set(user.id, now);
      alarms.raiseDuress(user.username);
      audit.record({ action: "panic.gesture", outcome: "allowed", actor: user.username, detail: "duress raised" });
    } else audit.record({ action: "panic.gesture", outcome: "denied", actor: user.username, detail: "quiet time" });
    return response.json({ ok: true });
  });
}
