/**
 * The observation service's routes (ARMOR-SERVER-AI): what it may ask - the context, one tiny grey frame of a camera - and what it may say - an observation, which raises an
 * alarm only while the system is armed. Its own token opens these and nothing else. See ../ai.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { AiError, FRAME_HEIGHT, FRAME_WIDTH, parseObservation } from "../ai.js";

export function registerAiRoutes(app: Express, context: AppContext): void {
  const { ai, alarms, audit, store, vault, requireAi } = context;
  const framesLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false });
  const param = (request: Request, name: string) => String(request.params[name] ?? "");

  /** The mode, the nodes with their radar tracks and light, and the cameras the service can look at. */
  app.get("/api/v1/ai/context", requireAi, (_request, response) => {
    const state = store.snapshot();
    response.json({
      mode: state.mode,
      nodes: Object.entries(state.nodes).map(([id, node]) => ({ id, online: node.online, targets: node.target_count, lux: node.lux })),
      cameras: vault.list().filter(camera => Boolean(camera.rtspPath && camera.secrets?.username && camera.secrets.password)).map(camera => ({ id: camera.id, name: camera.name })),
    });
  });

  app.get("/api/v1/ai/cameras/:id/frame", requireAi, framesLimit, async (request, response) => {
    const camera = vault.get(param(request, "id"));
    if (!camera) return response.status(404).json({ error: "unknown_camera" });
    try {
      const frame = await ai.frame(camera);
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Frame-Width", String(FRAME_WIDTH));
      response.setHeader("X-Frame-Height", String(FRAME_HEIGHT));
      return response.send(frame);
    } catch (error) {
      if (error instanceof AiError) return response.status(error.status).json({ error: error.code });
      return response.status(502).json({ error: "camera_not_answering" });
    }
  });

  app.post("/api/v1/ai/observations", requireAi, (request, response) => {
    const observation = parseObservation(request.body);
    if (!observation) return response.status(422).json({ error: "invalid_observation" });
    if (!vault.get(observation.camera_id)) return response.status(404).json({ error: "unknown_camera" });
    // An observation is only worth an alarm while the perimeter is armed; while it is not, it is told so and nothing is raised.
    if (store.snapshot().mode !== "armed") return response.json({ raised: false, reason: "disarmed" });
    const alarm = alarms.raise(`ai:camera:${observation.camera_id}:motion`, {
      source: { type: "camera", id: observation.camera_id }, severity: observation.severity === "high" ? "high" : "warning", code: "camera_motion",
      detail: { reasons: observation.reasons.join("; "), motion: Math.round(observation.motion * 100), radar_tracks: observation.radar_tracks, profile: observation.profile },
    });
    audit.record({ action: "ai.observation", outcome: "allowed", target: observation.camera_id, detail: `${observation.severity}${alarm ? ", alarm raised" : ", one is already open"}` });
    return response.json({ raised: Boolean(alarm), ...(alarm ? { alarm_id: alarm.id } : { reason: "already_open" }) });
  });
}
