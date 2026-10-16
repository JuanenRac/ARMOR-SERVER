/**
 * The state of the ARMOR-ALARM nodes' panels, and the only route that sends anything towards one: POST /api/v1/alarm/command (arm or disarm), for an administrator, refused
 * unless ARMOR_ALARM_COMMANDS=1 (see ../alarm_commands.ts). A disarm needs the PIN of the signed-in user, checked by this server; the node, the broker and this server must all have said yes.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { ingestCaller } from "../http/node_token.js";
import { forwardCompatible } from "../contracts.js";
import { ACTIONS, parseAlarmMessage, type AlarmAction } from "../alarm.js";
import { AlarmCommandError } from "../alarm_commands.js";
import { checkDisarm } from "./disarm_gate.js";
import { ZoneLinksInvalid } from "../alarm_zone_feed.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerAlarmNodeRoutes(app: Express, context: AppContext): void {
  const { config, alarmNodes, alarmCommands, requireOperator, requireAdmin, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });
  const commandLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many alarm commands" } });

  app.post("/api/v1/alarm/state", ingestLimit, (request, response) => {
    if (!ingestCaller(request, config.ingestToken, config.ingestStrict, (request.body as { node_id?: unknown } | undefined)?.node_id)) return response.sendStatus(401);
    try {
      const { value, ignored } = forwardCompatible(() => parseAlarmMessage(request.body));
      alarmNodes.ingest(value);
      context.ingestLog.ok(`http:alarm/${value.node_id}`, ignored);
      return response.status(202).json({ accepted: true, ...(ignored.length ? { ignored } : {}) });
    } catch (error) {
      const why = error instanceof Error ? error.message : "invalid alarm message";
      context.ingestLog.rejected("http:alarm", why, JSON.stringify(request.body ?? null));
      return response.status(400).json({ error: why });
    }
  });

  app.get("/api/v1/alarm/nodes", requireOperator, (_request, response) => response.json({ nodes: alarmNodes.list(), totals: alarmNodes.totals() }));

  // Which Zigbee device of the registry is which zone of which panel: the server tells the panel the state of those zones while it holds the radio (see ../alarm_zone_feed.ts).
  app.get("/api/v1/alarm/zone-links", requireOperator, (_request, response) => response.json({ links: context.alarmZoneFeed.list() }));
  app.put("/api/v1/alarm/zone-links", requireAdmin, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    try {
      const links = context.alarmZoneFeed.set(body.links);
      context.audit.record({ action: "alarm.zone_links", outcome: "allowed", target: `${links.length} links`, actor: studioUser(request)?.username ?? "admin" });
      return response.json({ links });
    } catch (error) {
      if (error instanceof ZoneLinksInvalid) return response.status(400).json({ error: error.message });
      throw error;
    }
  });

  // Whether the commands are on, the ones waiting for an answer and what became of the latest ones.
  app.get("/api/v1/alarm/commands", requireOperator, (_request, response) => response.json(alarmCommands.status()));

  // A command to one node: {"node", "action": "arm" | "disarm", "mode": "away" | "stay" (on an arm), "force": boolean (on an arm)}. Answered 202 with the command id (the node's
  // answer arrives later in /commands); a refusal is 4xx with a code. A disarm needs the PIN of the signed-in user (see disarm_gate.ts); the PIN is checked here and never sent to the node.
  app.post("/api/v1/alarm/command", requireAdmin, commandLimit, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const node = typeof body.node === "string" ? body.node : "";
    const known = ["node", "action", "mode", "force", "pin"];
    if (!NODE.test(node) || typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action) || Object.keys(body).some(key => !known.includes(key))
      || ("force" in body && typeof body.force !== "boolean") || ("mode" in body && body.mode !== "away" && body.mode !== "stay")) {
      return response.status(400).json({ error: "node, an action (arm or disarm) and, on an arm, a mode (away or stay) and optionally force are required", code: "invalid_request" });
    }
    const user = studioUser(request);
    if (body.action === "disarm") {
      // The panel itself does not ask for a PIN of a disarm that comes from the server (the broker, the node's own setting and this server must all have said yes): this server does.
      const verdict = checkDisarm(context, user, body.pin, user?.username ?? "administrator");
      if (!verdict.allow) return response.status(verdict.status).json(verdict.body);
      if (verdict.duress) context.alarms.raiseDuress(user?.username ?? "administrator");
    }
    try {
      const sent = alarmCommands.request(node, body.action as AlarmAction, body.mode as "away" | "stay" | undefined, body.force === true, studioUser(request)?.username ?? "administrator");
      return response.status(202).json({ accepted: true, command_id: sent.command_id });
    } catch (error) {
      if (error instanceof AlarmCommandError) return response.status(error.status).json({ error: error.message, code: error.code });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
