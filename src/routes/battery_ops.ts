/**
 * Writing to a Pylontech battery from Studio and the phone: arm, execute, cancel, restore and the list of what was done. Every route is for an administrator who proved themselves again a
 * moment ago (the password or the second factor, whatever the origin), and the whole is off unless the server runs with ARMOR_BATTERY_WRITE=1. See ../battery_write.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Request, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { BatteryOpsError } from "../battery_ops.js";

const ID = /^[a-z0-9]{8,32}$/;

export function registerBatteryOpsRoutes(app: Express, context: AppContext): void {
  const { batteryWrite, requireOperator, requireAdmin, studioSessions, audit, studioUser } = context;
  const actor = (request: Request): string => studioUser(request)?.username ?? "administrator";
  const orderLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many orders to batteries", code: "rate_limited" } });
  /** A fresh proof, always: unlike the other critical actions this is asked inside the house too, because a wrong order destroys a battery. */
  const requireFreshProof: RequestHandler = (request, response, next) => {
    if (studioSessions.elevated(request)) return next();
    audit.record({ action: "elevation.needed", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(403).json({ error: "this needs the password or the code again", code: "elevation_required" });
  };
  const fail = (response: express.Response, error: unknown) => {
    if (error instanceof BatteryOpsError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null && !Buffer.isBuffer(request.body) ? request.body as Record<string, unknown> : {});

  // The table of the operations and whether writing is on: for the screens to be built from it.
  app.get("/api/v1/solar/battery-ops/catalog", requireOperator, (_request, response) => response.json(batteryWrite.catalog()));

  app.get("/api/v1/solar/battery-ops", requireAdmin, (_request, response) => response.json({ enabled: batteryWrite.enabled, operations: batteryWrite.list() }));

  // A firmware image, kept in memory for an hour; nothing is sent to a battery.
  app.post("/api/v1/solar/battery-ops/images", requireAdmin, requireFreshProof, orderLimit, express.raw({ type: "application/octet-stream", limit: 600 * 1024 }), (request, response) => {
    if (!Buffer.isBuffer(request.body)) return response.status(415).json({ error: "send the .bin as application/octet-stream", code: "send_the_bin_as_octet_stream" });
    try { return response.status(201).json(batteryWrite.storeImage(actor(request), request.body)); } catch (error) { return fail(response, error); }
  });

  app.get("/api/v1/solar/battery-ops/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    const found = ID.test(id) ? batteryWrite.get(id) : undefined;
    return found ? response.json(found) : response.status(404).json({ error: "no such operation", code: "unknown_operation" });
  });

  // Step one: arm.
  app.post("/api/v1/solar/battery-ops", requireAdmin, requireFreshProof, orderLimit, (request, response) => {
    const input = body(request);
    try { return response.status(202).json(batteryWrite.arm(actor(request), { node: input.node, port: input.port, op: input.op, params: input.params, serial: input.serial })); } catch (error) { return fail(response, error); }
  });

  // Step two: execute, with the serial number typed again.
  app.post("/api/v1/solar/battery-ops/:id/execute", requireAdmin, requireFreshProof, orderLimit, (request, response) => {
    const id = String(request.params.id);
    if (!ID.test(id)) return response.status(404).json({ error: "no such operation", code: "unknown_operation" });
    try { return response.status(202).json(batteryWrite.execute(actor(request), id, body(request).serial)); } catch (error) { return fail(response, error); }
  });

  app.post("/api/v1/solar/battery-ops/:id/cancel", requireAdmin, orderLimit, (request, response) => {
    const id = String(request.params.id);
    if (!ID.test(id)) return response.status(404).json({ error: "no such operation", code: "unknown_operation" });
    try { return response.status(202).json(batteryWrite.cancel(actor(request), id)); } catch (error) { return fail(response, error); }
  });

  app.post("/api/v1/solar/battery-ops/:id/restore", requireAdmin, requireFreshProof, orderLimit, (request, response) => {
    const id = String(request.params.id);
    if (!ID.test(id)) return response.status(404).json({ error: "no such operation", code: "unknown_operation" });
    try { return response.status(202).json(batteryWrite.restore(actor(request), id, body(request).serial)); } catch (error) { return fail(response, error); }
  });
}
