/**
 * The state of the ARMOR-ALARM nodes' panels, and the only route that sends anything towards one: POST /api/v1/alarm/command (arm or disarm), for an administrator, refused
 * unless ARMOR_ALARM_COMMANDS=1 (see ../alarm_commands.ts). A disarm carries no PIN: the node, the broker and this server must all have said yes.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { forwardCompatible } from "../contracts.js";
import { ACTIONS, parseAlarmMessage, type AlarmAction } from "../alarm.js";
import { AlarmCommandError } from "../alarm_commands.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerAlarmNodeRoutes(app: Express, context: AppContext): void {
  const { config, alarmNodes, alarmCommands, requireOperator, requireAdmin, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });
  const commandLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many alarm commands" } });

  app.post("/api/v1/alarm/state", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
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

  // Whether the commands are on, the ones waiting for an answer and what became of the latest ones.
  app.get("/api/v1/alarm/commands", requireOperator, (_request, response) => response.json(alarmCommands.status()));

  // A command to one node: {"node", "action": "arm" | "disarm", "mode": "away" | "stay" (on an arm), "force": boolean (on an arm)}. Answered 202 with the command id (the node's
  // answer arrives later in /commands); a refusal is 4xx with a code. No PIN is accepted or sent.
  app.post("/api/v1/alarm/command", requireAdmin, commandLimit, (request, response) => {
    const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
    const node = typeof body.node === "string" ? body.node : "";
    const known = ["node", "action", "mode", "force"];
    if (!NODE.test(node) || typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action) || Object.keys(body).some(key => !known.includes(key))
      || ("force" in body && typeof body.force !== "boolean") || ("mode" in body && body.mode !== "away" && body.mode !== "stay")) {
      return response.status(400).json({ error: "node, an action (arm or disarm) and, on an arm, a mode (away or stay) and optionally force are required", code: "invalid_request" });
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
