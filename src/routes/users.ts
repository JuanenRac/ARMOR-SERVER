/**
 * Studio users: an administrator lists, creates, renames, re-keys, re-roles and removes them; any signed-in user can change their
 * own name and password (proving the current password first). Sessions of a user whose password, role or existence changed are ended.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { UserError } from "../users.js";

export function registerUserRoutes(app: Express, context: AppContext): void {
  const { audit, studioSessions, users, studioUser, requireAdmin } = context;
  const accountLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many account changes" } });

  const fail = (response: Response, error: unknown) => {
    if (error instanceof UserError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});

  app.get("/api/v1/users", requireAdmin, (request, response) => {
    const me = studioUser(request)?.id;
    return response.json({ users: users.list().map(user => ({ ...user, current: user.id === me })), minPasswordLength: users.minPasswordLength });
  });

  app.post("/api/v1/users", requireAdmin, (request, response) => {
    const input = body(request), actor = studioUser(request)?.username;
    try {
      const user = users.create({ username: input.username, password: input.password, role: input.role ?? "operator" });
      audit.record({ action: "user.create", outcome: "allowed", actor, target: user.username, detail: user.role });
      return response.status(201).json(user);
    } catch (error) {
      audit.record({ action: "user.create", outcome: "failed", actor, detail: error instanceof UserError ? error.code : "error" });
      return fail(response, error);
    }
  });

  app.patch("/api/v1/users/:id", requireAdmin, (request, response) => {
    const input = body(request), actor = studioUser(request), id = String(request.params.id);
    try {
      const changed = users.update(id, { username: input.username, password: input.password, role: input.role });
      // A different password or role must take effect at once: the user's other sessions end (this one stays when it is your own).
      if (changed.passwordChanged || changed.roleChanged) studioSessions.revokeUser(id, id === actor?.id ? request : undefined);
      audit.record({ action: "user.update", outcome: "allowed", actor: actor?.username, target: changed.user.username, detail: [input.username !== undefined && "name", changed.passwordChanged && "password", changed.roleChanged && "role"].filter(Boolean).join(",") });
      return response.json(changed.user);
    } catch (error) {
      audit.record({ action: "user.update", outcome: "failed", actor: actor?.username, target: id, detail: error instanceof UserError ? error.code : "error" });
      return fail(response, error);
    }
  });

  app.delete("/api/v1/users/:id", requireAdmin, (request, response) => {
    const actor = studioUser(request), id = String(request.params.id);
    try {
      if (id === actor?.id) throw new UserError("self_delete", "you cannot delete the user you are signed in as", 409);
      const target = users.get(id);
      users.remove(id);
      studioSessions.revokeUser(id);
      audit.record({ action: "user.delete", outcome: "allowed", actor: actor?.username, target: target?.username });
      return response.sendStatus(204);
    } catch (error) {
      audit.record({ action: "user.delete", outcome: "failed", actor: actor?.username, target: id, detail: error instanceof UserError ? error.code : "error" });
      return fail(response, error);
    }
  });

  // Your own account: rename and change the password, whatever your role, after confirming the current password.
  app.patch("/api/v1/account", accountLimit, (request, response) => {
    const me = studioUser(request);
    if (!me) return response.status(401).json({ error: "sign in first" });
    const input = body(request);
    if (input.username === undefined && input.newPassword === undefined) return response.status(400).json({ error: "nothing to change", code: "nothing_to_change" });
    if (typeof input.currentPassword !== "string" || !users.authenticate(me.username, input.currentPassword)) {
      audit.record({ action: "account.update", outcome: "denied", actor: me.username, detail: "current password" });
      return response.status(403).json({ error: "the current password is not right", code: "wrong_password" });
    }
    try {
      const changed = users.update(me.id, { username: input.username, password: input.newPassword });
      if (changed.passwordChanged) studioSessions.revokeUser(me.id, request);
      audit.record({ action: "account.update", outcome: "allowed", actor: changed.user.username, detail: [input.username !== undefined && "name", changed.passwordChanged && "password"].filter(Boolean).join(",") });
      return response.json({ id: changed.user.id, username: changed.user.username, role: changed.user.role });
    } catch (error) {
      audit.record({ action: "account.update", outcome: "failed", actor: me.username, detail: error instanceof UserError ? error.code : "error" });
      return fail(response, error);
    }
  });
}
