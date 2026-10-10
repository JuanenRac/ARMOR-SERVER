/**
 * Devices: the registry (an operator lists, adds, edits and removes devices), their state (pushed by a device with the ingest token, or
 * set by hand for a test), and commands to actuators.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { KIND_LIST, PROTOCOLS, kindInfo, cleanState } from "../devices/catalog.js";
import { defaultRisk } from "../devices/catalog.js";
import { isCommand } from "../devices/commands.js";
import { DeviceError, type Device } from "../devices/registry.js";
import { hasBearer } from "../http/auth.js";

/** A device for a client: everything but nothing secret (a command URL may carry a key, so only whether one is set is shown). */
export function deviceView(device: Device) {
  const { commands, ...rest } = device;
  return {
    ...rest,
    category: kindInfo(device.kind).category,
    commands: {
      ...(commands.mqtt ? { mqtt: { topic: commands.mqtt.topic, on: commands.mqtt.on, off: commands.mqtt.off, toggle: commands.mqtt.toggle, assume_state: commands.mqtt.assume_state } } : {}),
      ...(commands.http ? { http: { on: Boolean(commands.http.on), off: Boolean(commands.http.off), toggle: Boolean(commands.http.toggle) } } : {}),
    },
    can_command: Boolean(commands.mqtt || commands.http),
  };
}

export function registerDeviceRoutes(app: Express, context: AppContext): void {
  const { config, devices, audit, requireOperator, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 3_000, standardHeaders: "draft-8", legacyHeaders: false });
  const commandLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many device commands" } });
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const fail = (response: Response, error: unknown) => {
    if (error instanceof DeviceError) return response.status(error.status).json({ error: error.message, code: error.code });
    return response.status(500).json({ error: "internal error" });
  };

  app.get("/api/v1/devices", requireOperator, (_request, response) => response.json({
    devices: devices.list().map(deviceView),
    kinds: KIND_LIST.map(kind => ({ kind, category: kindInfo(kind).category, alarm: kindInfo(kind).alarm, severity: kindInfo(kind).severity, commands: kindInfo(kind).commands, default_risk: defaultRisk(kind) })),
    protocols: PROTOCOLS,
  }));

  app.post("/api/v1/devices", requireOperator, (request, response) => {
    const input = body(request);
    try {
      const device = devices.create({ id: typeof input.id === "string" && input.id ? input.id : undefined, name: input.name as string, kind: input.kind as Device["kind"], protocol: input.protocol as Device["protocol"], location: input.location as string, source: input.source as Device["source"], commands: input.commands as Device["commands"], expected_interval_s: input.expected_interval_s as number, risk: input.risk as Device["risk"] | undefined });
      audit.record({ action: "device.create", outcome: "allowed", actor: actor(request), target: device.id, detail: device.kind });
      return response.status(201).json(deviceView(device));
    } catch (error) { audit.record({ action: "device.create", outcome: "failed", actor: actor(request), detail: error instanceof DeviceError ? error.code : "error" }); return fail(response, error); }
  });

  app.patch("/api/v1/devices/:id", requireOperator, (request, response) => {
    const input = body(request), id = String(request.params.id);
    try {
      const device = devices.update(id, { name: input.name as string | undefined, kind: input.kind as Device["kind"] | undefined, protocol: input.protocol as Device["protocol"] | undefined, location: input.location as string | undefined, source: input.source as Device["source"] | undefined, commands: input.commands as Device["commands"] | undefined, expected_interval_s: input.expected_interval_s as number | undefined, risk: input.risk as Device["risk"] | undefined });
      audit.record({ action: "device.update", outcome: "allowed", actor: actor(request), target: id });
      return response.json(deviceView(device));
    } catch (error) { return fail(response, error); }
  });

  app.delete("/api/v1/devices/:id", requireOperator, (request, response) => {
    const id = String(request.params.id);
    try {
      devices.remove(id);
      context.alarmRules.forgetDevice(id);
      audit.record({ action: "device.delete", outcome: "allowed", actor: actor(request), target: id });
      return response.sendStatus(204);
    } catch (error) { return fail(response, error); }
  });

  app.post("/api/v1/devices/:id/command", requireOperator, commandLimit, async (request, response) => {
    const id = String(request.params.id), command = body(request).command;
    if (!isCommand(command)) return response.status(400).json({ error: "the command is on, off or toggle", code: "invalid_command" });
    // What matters when it goes off: a circuit of the board needs a confirmation in the request, and a critical one an administrator as well.
    const target = devices.get(id);
    if (target && target.risk !== "low") {
      if (body(request).confirm !== true) return response.status(409).json({ error: "this device needs a confirmation to be switched", code: "confirmation_required", risk: target.risk });
      if (target.risk === "critical" && studioUser(request)?.role !== "admin") { audit.record({ action: "device.command", outcome: "denied", actor: actor(request), target: `${id}=${command}`, detail: "critical" }); return response.status(403).json({ error: "a critical circuit is switched by an administrator", code: "admin_required", risk: target.risk }); }
    }
    try {
      const done = await context.sendDeviceCommand(id, command);
      audit.record({ action: "device.command", outcome: "allowed", actor: actor(request), target: `${id}=${done.command}`, detail: done.via });
      return response.json({ ok: true, via: done.via, command: done.command, device: deviceView(devices.get(id)!) });
    } catch (error) {
      audit.record({ action: "device.command", outcome: "failed", actor: actor(request), target: `${id}=${command}`, detail: error instanceof DeviceError ? error.code : "error" });
      return error instanceof DeviceError ? fail(response, error) : response.status(502).json({ error: "the command could not be sent", code: "command_failed" });
    }
  });

  // A device reports its state with the ingest token (a script, a bridge, an ESP32).
  app.post("/api/v1/devices/state", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    const input = body(request), id = input.device_id;
    if (typeof id !== "string" || !devices.get(id)) return response.status(404).json({ error: "unknown device" });
    const state = cleanState(input.state);
    if (Object.keys(state).length === 0) return response.status(400).json({ error: "the report has no valid field" });
    devices.applyState(id, state);
    return response.status(202).json({ accepted: true });
  });

  // An operator sets a state by hand: to try an alarm or an automation without touching the real sensor. Audited.
  app.post("/api/v1/devices/:id/state", requireOperator, (request, response) => {
    const id = String(request.params.id), state = cleanState(body(request).state);
    if (!devices.get(id)) return response.status(404).json({ error: "no such device", code: "not_found" });
    if (Object.keys(state).length === 0) return response.status(400).json({ error: "the state has no valid field", code: "invalid_state" });
    devices.applyState(id, state);
    audit.record({ action: "device.state.manual", outcome: "allowed", actor: actor(request), target: id, detail: Object.keys(state).join(",") });
    return response.json(deviceView(devices.get(id)!));
  });
}
