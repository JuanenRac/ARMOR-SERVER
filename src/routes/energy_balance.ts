/**
 * The energy balance of the house (see ../energy_balance.ts):
 *   GET /api/v1/electrical/balance   production, consumption, import, export, self-consumption and autarky now, the findings that are open and the settings (operators and administrators)
 *   PUT /api/v1/electrical/balance   the settings (an administrator; a new proof of identity from outside the house)
 * While the option `electrical.balance` is off (the default) both answer 404 `balance_off`: nothing is worked out or watched.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import type { AppContext } from "../context.js";
import { BalanceInvalid } from "../energy_balance.js";

export function registerEnergyBalanceRoutes(app: Express, context: AppContext): void {
  const { balanceWatcher, requireOperator, requireAdmin, audit, studioUser, securitySettings } = context;
  const actor = (request: Request): string | undefined => studioUser(request)?.username;
  const off = (): boolean => !securitySettings.get("electrical.balance");

  app.get("/api/v1/electrical/balance", requireOperator, (_request, response) => {
    if (off()) return response.status(404).json({ error: "the energy balance is not turned on", code: "balance_off" });
    response.set("Cache-Control", "private, no-store");
    return response.json(balanceWatcher.status());
  });

  app.put("/api/v1/electrical/balance", requireAdmin, context.requireElevated, (request, response) => {
    if (off()) return response.status(404).json({ error: "the energy balance is not turned on", code: "balance_off" });
    try {
      const settings = balanceWatcher.configure(request.body);
      audit.record({ action: "electrical.balance.configure", outcome: "allowed", actor: actor(request), detail: `export ${settings.allow_export ? "allowed" : `watched above ${settings.export_alert_w} W`}, ${settings.watch_channels.length} channels watched` });
      return response.json(balanceWatcher.status());
    } catch (error) {
      if (error instanceof BalanceInvalid) {
        audit.record({ action: "electrical.balance.configure", outcome: "denied", actor: actor(request), detail: error.code });
        return response.status(422).json({ error: error.message, code: error.code });
      }
      return response.status(500).json({ error: "internal error" });
    }
  });
}
