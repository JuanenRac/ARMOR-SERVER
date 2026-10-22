/**
 * The security options of the server, set from Studio by an administrator (see ../security_settings.ts), and the key a panel verifies the zone messages with.
 *   GET /api/v1/security/settings              the options in force, the stored ones, the defaults and the ones the environment fixes
 *   PUT /api/v1/security/settings              change one or more ({ "alarm.disarm_pin": "never", ... }); the audit trail says which ones lowered the security
 *   GET /api/v1/alarm/zone-feed/key/{node}  the key of one panel for the signature of its zone messages (an administrator who proved themselves again if they came from outside)
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { lowers, SECURITY_DEFAULTS, SecuritySettingsInvalid, type SecuritySettingKey } from "../security_settings.js";

export function registerSecurityRoutes(app: Express, context: AppContext): void {
  const { securitySettings, audit, requireAdmin, requireElevated, studioUser, zoneFeedSigner } = context;
  const view = () => ({ settings: securitySettings.effective, stored: securitySettings.stored, defaults: SECURITY_DEFAULTS, locked: securitySettings.lockedKeys });

  app.get("/api/v1/security/settings", requireAdmin, (_request, response) => response.json(view()));

  app.put("/api/v1/security/settings", requireAdmin, requireElevated, (request, response) => {
    const actor = studioUser(request)?.username ?? "admin";
    const before = securitySettings.effective;
    try {
      const changes = securitySettings.update(request.body);
      for (const [key, value] of Object.entries(changes)) {
        const lowered = lowers(key as SecuritySettingKey, before[key as SecuritySettingKey], value);
        audit.record({ action: "security.setting", outcome: "allowed", actor, target: key, detail: `${String(before[key as SecuritySettingKey])} -> ${String(value)}${lowered ? " (lowers the security)" : ""}` });
      }
      return response.json(view());
    } catch (error) {
      if (error instanceof SecuritySettingsInvalid) {
        audit.record({ action: "security.setting", outcome: "denied", actor, target: error.key, detail: error.message });
        return response.status(400).json({ error: error.message, code: "invalid_setting", ...(error.key ? { setting: error.key } : {}) });
      }
      return response.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/v1/alarm/zone-feed/key/:node", requireAdmin, requireElevated, (request, response) => {
    const node = String(request.params.node ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(node)) return response.status(400).json({ error: "invalid node id", code: "invalid_node" });
    audit.record({ action: "zone_feed.key", outcome: "allowed", actor: studioUser(request)?.username ?? "admin", target: node });
    response.setHeader("Cache-Control", "no-store");
    return response.json({ node_id: node, key: zoneFeedSigner.keyFor(node), algorithm: "HMAC-SHA256" });
  });
}
