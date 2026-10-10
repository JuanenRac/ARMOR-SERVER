/**
 * The readings of the ARMOR-ELECTRICAL nodes: the messages the nodes send over HTTP (over MQTT they arrive in app.ts), and what Studio reads. The only route that
 * sends anything towards a node is POST /api/v1/electrical/switch: for an administrator, refused unless ARMOR_ELECTRICAL_SWITCHING=1 (see ../electrical_switching.ts).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { forwardCompatible } from "../contracts.js";
import { kindInfo } from "../devices/catalog.js";
import { SWITCH_ACTIONS, parseElectricalMessage, type SwitchAction } from "../electrical.js";
import { SwitchingError } from "../electrical_switching.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function registerElectricalRoutes(app: Express, context: AppContext): void {
  const { config, electricalNodes, electricalSwitching, requireOperator, requireAdmin, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });
  const switchLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many switch commands" } });

  app.post("/api/v1/electrical/readings", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      const { value, ignored } = forwardCompatible(() => parseElectricalMessage(request.body));
      electricalNodes.ingest(value);
      context.ingestLog.ok(`http:electrical/${value.node_id}`, ignored);
      return response.status(202).json({ accepted: true, ...(ignored.length ? { ignored } : {}) });
    } catch (error) {
      const why = error instanceof Error ? error.message : "invalid electrical message";
      context.ingestLog.rejected("http:electrical", why, JSON.stringify(request.body ?? null));
      return response.status(400).json({ error: why });
    }
  });

  // The devices of the house that measure or switch electricity (a Zigbee plug or breaker, a meter, a smart light): what they say, whether they can be switched and how much it matters.
  // They are the same "electrical elements" as the channels of the nodes' meters, seen from the device registry.
  app.get("/api/v1/electrical/devices", requireOperator, (_request, response) => {
    const items = context.devices.list().filter(device => ["smart_breaker", "energy_meter", "smart_plug", "smart_switch", "smart_light"].includes(device.kind) || ["power_w", "energy_kwh", "voltage_v", "current_a"].some(field => field in device.state));
    const elements = items.map(device => ({
      id: device.id, name: device.name, kind: device.kind, protocol: device.protocol, location: device.location, online: device.online, last_seen: device.last_seen, risk: device.risk,
      ...(typeof device.state.on === "boolean" ? { on: device.state.on } : {}),
      ...(typeof device.state.power_w === "number" ? { power_w: device.state.power_w } : {}), ...(typeof device.state.voltage_v === "number" ? { voltage_v: device.state.voltage_v } : {}),
      ...(typeof device.state.current_a === "number" ? { current_a: device.state.current_a } : {}), ...(typeof device.state.energy_kwh === "number" ? { energy_kwh: device.state.energy_kwh } : {}),
      switchable: Boolean(device.commands.mqtt || device.commands.http) && kindInfo(device.kind).commands.length > 0,
    }));
    const live = elements.filter(item => item.online);
    return response.json({
      elements,
      totals: { elements: elements.length, online: live.length, on: live.filter(item => item.on === true).length, power_w: Math.round(live.reduce((sum, item) => sum + (item.power_w ?? 0), 0) * 10) / 10,
        energy_kwh: Math.round(elements.reduce((sum, item) => sum + (item.energy_kwh ?? 0), 0) * 100) / 100 },
    });
  });

  app.get("/api/v1/electrical/readings", requireOperator, (_request, response) => response.json({ nodes: electricalNodes.list(), totals: electricalNodes.totals() }));

  // Whether switching is on, the commands waiting for an answer and what became of the latest ones. Never a token.
  app.get("/api/v1/electrical/switching", requireOperator, (_request, response) => response.json(electricalSwitching.status()));

  // A command to one switch of one node: {"node", "switch", "action"} with the action arm, close_a, close_b, open or acknowledge. Answered 202 with the command id
  // (the node's answer arrives later in /switching); a refusal is 4xx with a code. Closing is two calls: arm, then close_a or close_b once the arm was accepted.
  app.post("/api/v1/electrical/switch", requireAdmin, switchLimit, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const node = typeof body.node === "string" ? body.node : "", target = typeof body.switch === "string" ? body.switch : "";
    if (!NODE.test(node) || !CHANNEL.test(target) || typeof body.action !== "string" || !(SWITCH_ACTIONS as readonly string[]).includes(body.action)) {
      return response.status(400).json({ error: "node, switch and an action (arm, close_a, close_b, open or acknowledge) are required", code: "invalid_request" });
    }
    try {
      const sent = electricalSwitching.request(node, target, body.action as SwitchAction, studioUser(request)?.username ?? "administrator");
      return response.status(202).json({ accepted: true, command_id: sent.command_id });
    } catch (error) {
      if (error instanceof SwitchingError) return response.status(error.status).json({ error: error.message, code: error.code });
      return response.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/v1/electrical/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    const channel = typeof request.query.channel === "string" ? request.query.channel : "";
    if (!NODE.test(node) || !CHANNEL.test(channel)) return response.status(400).json({ error: "node and channel are required" });
    const asked = Number(request.query.minutes ?? 60);
    const minutes = Number.isFinite(asked) ? Math.min(43_200, Math.max(1, Math.round(asked))) : 60;
    const samples = electricalNodes.history(node, channel, minutes);
    if (!samples) return response.status(404).json({ error: "unknown electrical channel" });
    return response.json({ node_id: node, channel, minutes, samples });
  });
}
