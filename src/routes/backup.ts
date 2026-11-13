/**
 * Encrypted, scheduled backups of the data directory, for an administrator (see ../backup.ts):
 *   GET  /api/v1/admin/backup          the settings, whether a passphrase is set, the last result and the backups on the destination
 *   PUT  /api/v1/admin/backup          the settings (and, when given, the passphrase that makes the key); a new proof of identity from outside the house
 *   POST /api/v1/admin/backup/run      make a backup now
 *   POST /api/v1/admin/backup/verify   prove a backup: open it, check every hash and write it to a temporary folder that is removed (the newest, or `name`)
 * While the security option `admin.backup` is off (the default) the three that act answer 403 `backup_disabled` and the first says so. The passphrase is never returned, kept or written to the audit trail.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import type { AppContext } from "../context.js";
import { BackupError } from "../backup.js";

export function registerBackupRoutes(app: Express, context: AppContext): void {
  const { backup, requireAdmin, audit, studioUser, securitySettings } = context;
  const actor = (request: Request): string | undefined => studioUser(request)?.username;
  const on = (): boolean => securitySettings.get("admin.backup");
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const fail = (request: Request, action: string, error: unknown, response: { status(code: number): { json(value: unknown): unknown } }): unknown => {
    if (error instanceof BackupError) {
      audit.record({ action, outcome: "denied", actor: actor(request), detail: error.code });
      return response.status(error.status).json({ error: error.message, code: error.code });
    }
    audit.record({ action, outcome: "failed", actor: actor(request) });
    return response.status(500).json({ error: "internal error" });
  };

  app.get("/api/v1/admin/backup", requireAdmin, (_request, response) => {
    response.set("Cache-Control", "private, no-store");
    return response.json({ enabled: on(), ...backup.status() });
  });

  app.put("/api/v1/admin/backup", requireAdmin, context.requireElevated, (request, response) => {
    if (!on()) return response.status(403).json({ error: "backups are not turned on in the security options", code: "backup_disabled" });
    try {
      const settings = backup.configure(body(request));
      audit.record({ action: "backup.configure", outcome: "allowed", actor: actor(request), detail: `${settings.schedule ? `every ${settings.every_h} h` : "not scheduled"}, keep ${settings.keep}${"passphrase" in body(request) ? ", new passphrase" : ""}` });
      return response.json({ enabled: true, ...backup.status() });
    } catch (error) { return fail(request, "backup.configure", error, response); }
  });

  app.post("/api/v1/admin/backup/run", requireAdmin, context.requireElevated, async (request, response) => {
    if (!on()) return response.status(403).json({ error: "backups are not turned on in the security options", code: "backup_disabled" });
    try {
      const result = await backup.run(actor(request));
      audit.record({ action: "backup.run", outcome: "allowed", actor: actor(request), target: result.file, detail: `${result.files} files, ${result.bytes} bytes` });
      return response.json(result);
    } catch (error) { return fail(request, "backup.run", error, response); }
  });

  app.post("/api/v1/admin/backup/verify", requireAdmin, async (request, response) => {
    if (!on()) return response.status(403).json({ error: "backups are not turned on in the security options", code: "backup_disabled" });
    const { name, passphrase } = body(request);
    if ((name !== undefined && typeof name !== "string") || (passphrase !== undefined && typeof passphrase !== "string")) return response.status(422).json({ error: "name and passphrase are text", code: "invalid_request" });
    try {
      const result = await backup.verify(name as string | undefined, passphrase as string | undefined);
      audit.record({ action: "backup.verify", outcome: "allowed", actor: actor(request), target: result.file, detail: `${result.files} files` });
      return response.json(result);
    } catch (error) { return fail(request, "backup.verify", error, response); }
  });
}
