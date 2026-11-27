/**
 * The solar routes of a small wall screen. Reading: operators, administrators and viewers as for GET /api/v1/solar, and the account of a wall panel only while the option panel.solar is on.
 *
 * Writing: ONE operation on a battery, resetting its statistics counters, and only for the account of a wall panel while the options solar.panel_battery_ops AND solar.battery_write are on
 * (both off by default), only from the house or the VPN, and with the PIN of that account typed for every step (the same lockout as disarming; the duress PIN goes through and raises its
 * silent alarm, as everywhere). The two steps, the one-time token of the node, the serial number typed again and the read-back are those of ../battery_write.ts, and every attempt is audited.
 * Checking a battery needs no route of its own: the screen reads the device again.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { BatteryOpsError } from "../battery_ops.js";
import type { BatteryOperation } from "../battery_write.js";
import { PANEL_HISTORY_MINUTES, panelDevice, panelDevices, thinHistory } from "../panel_solar.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID = /^[a-z0-9]{8,32}$/;
/** The only operation a wall screen may order. */
export const PANEL_BATTERY_OPERATION = "clear_stats";

/** What a screen is shown of an operation: how far it is and how it ended, never the transcript. */
const shown = (operation: BatteryOperation) => ({
  id: operation.id, node: operation.node, port: operation.port, op: operation.op, stage: operation.stage, risk: operation.risk, summary: operation.summary, battery: operation.battery,
  refusal: operation.refusal, outcome: operation.outcome, code: operation.code, armed_until: operation.armed_until,
});

export function registerPanelSolarRoutes(app: Express, context: AppContext): void {
  const { solar, solarRegistry, batteryWrite, securitySettings, studioUser, studioSessions, users, requireOperator, audit } = context;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const nameOf = (node: string, device: string): string | undefined => solarRegistry.get(node, device)?.name;

  /** Whether the person asking may order the operation at all (their PIN is asked on top of this). */
  const may = (request: Request): boolean => {
    const user = studioUser(request);
    return securitySettings.get("solar.panel_battery_ops") && batteryWrite.enabled && user?.role === "panel" && user.hasPin;
  };

  app.get("/api/v1/panel/solar", requireOperator, (request, response) => {
    const { devices, omitted } = panelDevices(solar.list(), nameOf);
    return response.json({ devices, omitted, totals: solar.totals(), battery_ops: { enabled: securitySettings.get("solar.panel_battery_ops") && batteryWrite.enabled, may: may(request), operations: [PANEL_BATTERY_OPERATION] } });
  });

  app.get("/api/v1/panel/solar/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    const device = typeof request.query.device === "string" ? request.query.device : "";
    if (!NODE.test(node) || !DEVICE.test(device)) return response.status(400).json({ error: "node and device are required", code: "invalid_request" });
    const asked = Number(request.query.minutes ?? 180);
    const minutes = Number.isFinite(asked) ? Math.min(PANEL_HISTORY_MINUTES, Math.max(1, Math.round(asked))) : 180;
    const history = solar.history(node, device, minutes);
    if (!history) return response.status(404).json({ error: "unknown solar device", code: "unknown_device" });
    return response.json({ node_id: node, device, kind: history.kind, minutes, samples: thinHistory(history.samples) });
  });

  app.get("/api/v1/panel/solar/devices/:node/:device", requireOperator, (request, response) => {
    const node = String(request.params.node), device = String(request.params.device);
    const view = solar.list().find(item => item.node_id === node && item.device === device);
    if (!view) return response.status(404).json({ error: "unknown solar device", code: "unknown_device" });
    return response.json({ devices: [panelDevice(view, nameOf(node, device))], totals: solar.totals() });
  });

  // ---- the one operation --------------------------------------------------------------------------------------------------------------------

  const orderLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many orders to batteries", code: "rate_limited" } });

  const refuse = (request: Request, response: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): undefined => {
    audit.record({ action: "panel.battery_ops", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}`, detail: code });
    response.status(status).json({ error, code, ...extra });
    return undefined;
  };

  /** The account of a wall panel, from the house, with both options on. Answers the refusal itself. */
  const panelAccount = (request: Request, response: Response) => {
    const user = studioUser(request);
    if (user?.role !== "panel") return refuse(request, response, 403, "panel_account_only", "only the account of a wall panel orders from here; an administrator uses the battery operations");
    if (studioSessions.originOf(request) === "remote") return refuse(request, response, 403, "panel_local_only", "a wall screen orders from the house or the VPN only");
    if (!securitySettings.get("solar.panel_battery_ops")) return refuse(request, response, 403, "panel_battery_ops_disabled", "battery operations from a wall screen are not turned on in this server");
    if (!batteryWrite.enabled) return refuse(request, response, 403, "battery_write_disabled", "writing to batteries is not turned on in this server");
    return user;
  };

  /** The PIN of the account, for this one step. Answers the refusal itself. */
  const pinPassed = async (request: Request, response: Response, user: { id: string; username: string }): Promise<boolean> => {
    const pin = body(request).pin;
    if (typeof pin !== "string" || pin === "") { refuse(request, response, 400, "pin_required", "type the PIN"); return false; }
    const result = await users.verifyPinLater(user.id, pin);
    if (result === "none") { refuse(request, response, 403, "pin_not_set", "this account has no PIN; an administrator sets it"); return false; }
    if (result === "locked") { refuse(request, response, 429, "pin_locked", "too many wrong PINs; try again later", { retry_after_s: users.pinLockedFor(user.id) }); return false; }
    if (result === "bad") { refuse(request, response, 403, "wrong_pin", "the PIN is not right"); return false; }
    if (result === "duress") context.raiseDuress(request, user.username, "pin");
    return true;
  };

  const fail = (response: Response, error: unknown) => {
    if (error instanceof BatteryOpsError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };
  /** An operation this same account armed from a screen; any other is not there for it. */
  const own = (id: string, username: string): BatteryOperation | undefined => {
    const operation = ID.test(id) ? batteryWrite.get(id) : undefined;
    return operation && operation.actor === username && operation.op === PANEL_BATTERY_OPERATION ? operation : undefined;
  };

  app.post("/api/v1/panel/solar/battery-ops", orderLimit, requireOperator, async (request, response) => {
    const user = panelAccount(request, response);
    if (!user) return;
    const input = body(request);
    if (input.op !== undefined && input.op !== PANEL_BATTERY_OPERATION) return void refuse(request, response, 403, "operation_not_from_panel", "a wall screen only resets the counters of a battery");
    if (!await pinPassed(request, response, user)) return;
    try {
      const operation = batteryWrite.arm(user.username, { node: input.node, port: input.port, op: PANEL_BATTERY_OPERATION, params: {}, serial: input.serial });
      response.status(202).json(shown(operation));
    } catch (error) { fail(response, error); }
  });

  app.get("/api/v1/panel/solar/battery-ops/:id", requireOperator, (request, response) => {
    const user = panelAccount(request, response);
    if (!user) return;
    const operation = own(String(request.params.id), user.username);
    if (!operation) return void response.status(404).json({ error: "no such operation", code: "unknown_operation" });
    response.json(shown(operation));
  });

  app.post("/api/v1/panel/solar/battery-ops/:id/execute", orderLimit, requireOperator, async (request, response) => {
    const user = panelAccount(request, response);
    if (!user) return;
    const operation = own(String(request.params.id), user.username);
    if (!operation) return void response.status(404).json({ error: "no such operation", code: "unknown_operation" });
    if (!await pinPassed(request, response, user)) return;
    try { response.status(202).json(shown(batteryWrite.execute(user.username, operation.id, body(request).serial))); } catch (error) { fail(response, error); }
  });
}
