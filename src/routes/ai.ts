/**
 * The observation service's routes (ARMOR-SERVER-AI): what it may ask - the context, one tiny grey frame of a camera - and what it may say - an observation, which raises an
 * alarm only while the system is armed. Its own token opens these and nothing else. See ../ai.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { AiError, FRAME_HEIGHT, FRAME_WIDTH, parseActivityEvent, parseObservation, parseVisionEvent } from "../ai.js";
import { coveringNodes } from "../ai_cover.js";

/** A camera that keeps seeing movement is one alarm per this long, not one for ever (the alarm of an observation is an event: it ends the moment it is raised and leaves the list when somebody acknowledges it). */
const MOTION_WINDOW_MS = 5 * 60_000;

export function registerAiRoutes(app: Express, context: AppContext): void {
  const { ai, alarms, audit, store, vault, requireAi, site } = context;
  // The service asks for one picture per camera every few seconds: 240 a minute for all the cameras of a house is too tight for ten of them, so it has its own, larger allowance.
  const framesLimit = rateLimit({ windowMs: 60_000, limit: 1_200, standardHeaders: "draft-8", legacyHeaders: false });
  const param = (request: Request, name: string) => String(request.params[name] ?? "");

  /** The mode, the nodes with their radar tracks and light, and the cameras the service can look at. */
  app.get("/api/v1/ai/context", requireAi, (_request, response) => {
    const state = store.snapshot();
    response.json({
      mode: state.mode,
      nodes: Object.entries(state.nodes).map(([id, node]) => ({ id, online: node.online, targets: node.target_count, lux: node.lux })),
      // `nodes`: the radar nodes that cover each camera in the site design (absent when the design cannot say: every node then counts).
      cameras: vault.list().filter(camera => Boolean(camera.rtspPath && camera.secrets?.username && camera.secrets.password)).map(camera => {
        const nodes = coveringNodes(site.get().site, camera.id);
        const ignore = context.ignoreZones.get(camera.id);
        const lines = context.countLines.get(camera.id);
        const detection = context.detectionZones.get(camera.id);
        return { id: camera.id, name: camera.name, ...(nodes ? { nodes } : {}), ...(ignore.length ? { ignore } : {}), ...(lines.length ? { lines } : {}), ...(detection.zones.length ? { detection } : {}) };
      }),
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
    const alarm = alarms.raise(`ai:camera:${observation.camera_id}:motion:${Math.floor(Date.now() / MOTION_WINDOW_MS)}`, {
      source: { type: "camera", id: observation.camera_id }, severity: observation.severity === "high" ? "high" : "warning", code: "camera_motion",
      detail: { reasons: observation.reasons.join("; "), motion: Math.round(observation.motion * 100), ...(observation.motion_ratio !== undefined ? { motion_ratio: Math.round(observation.motion_ratio * 1000) / 10 } : {}), ...(observation.regions?.length ? { regions: observation.regions.length } : {}), radar_tracks: observation.radar_tracks, profile: observation.profile }, instant: true,
    });
    // The perimeter is armed and a camera saw something: the evidence is taken now, without waiting for anybody (it has its own cooldown and settings).
    const watched = vault.get(observation.camera_id);
    if (watched) void context.captureOnDetect.trigger(watched).catch(() => undefined);
    audit.record({ action: "ai.observation", outcome: "allowed", target: observation.camera_id, detail: `${observation.severity}${alarm ? ", alarm raised" : ", one is already open"}` });
    return response.json({ raised: Boolean(alarm), ...(alarm ? { alarm_id: alarm.id } : { reason: "already_open" }) });
  });

  /** One object that entered a zone, as ARMOR-VISION reports it. A zone of kind `alert` raises an alarm only while the system is armed, once per camera and zone until it is closed; a `detection` zone is only recorded in the audit. */
  app.post("/api/v1/ai/vision-events", requireAi, (request, response) => {
    const event = parseVisionEvent(request.body);
    if (!event) return response.status(422).json({ error: "invalid_vision_event" });
    if (!vault.get(event.camera_id)) return response.status(404).json({ error: "unknown_camera" });
    if (event.type === "detection") {
      audit.record({ action: "ai.vision_event", outcome: "allowed", target: event.camera_id, detail: `detection ${event.label} in ${event.zone_id}` });
      return response.json({ raised: false, reason: "recorded" });
    }
    if (store.snapshot().mode !== "armed") return response.json({ raised: false, reason: "disarmed" });
    const heading = event.vectors?.find(vector => vector.track_id === event.track_id);
    const alarm = alarms.raise(`ai:camera:${event.camera_id}:zone:${event.zone_id}:${Math.floor(Date.now() / MOTION_WINDOW_MS)}`, {
      source: { type: "camera", id: event.camera_id }, severity: "high", code: "camera_motion",
      detail: { zone: event.zone_name, label: event.label, confidence: Math.round(event.confidence * 100), ...(event.radar_tracks !== undefined ? { radar_tracks: event.radar_tracks } : {}),
        ...(heading ? { heading: `${heading.dx.toFixed(2)},${heading.dy.toFixed(2)}`, speed: heading.speed } : {}) }, instant: true,
    });
    const watched = vault.get(event.camera_id);
    if (watched) void context.captureOnDetect.trigger(watched).catch(() => undefined);
    audit.record({ action: "ai.vision_event", outcome: "allowed", target: event.camera_id, detail: `alert ${event.label} in ${event.zone_id}${alarm ? ", alarm raised" : ", one is already open"}` });
    return response.json({ raised: Boolean(alarm), ...(alarm ? { alarm_id: alarm.id } : { reason: "already_open" }) });
  });

  /**
   * One event of the activity engine of ARMOR-VISION (a zone entered, left, stayed in or loitered in; a counting line crossed). While the option `vision.activity_events` is off (it is on by default) nothing is read and the answer is `{ raised: false, reason: feature_off }`, noted in the audit. On, it is recorded in the audit. An entry, a stay or a loitering in a zone
   * of kind `alert` raises an alarm, only while the system is armed and only when the event does not say `notify: false` (the profile of the arming mode watches the zone without telling the people the
   * alarms go to); a zone the server does not know (one of the configuration of the service) and a `detection` zone are only recorded.
   */
  app.post("/api/v1/ai/activity-events", requireAi, (request, response) => {
    if (!context.securitySettings.get("vision.activity_events")) { audit.record({ action: "ai.activity_event", outcome: "denied", detail: "feature_off" }); return response.json({ raised: false, reason: "feature_off" }); }
    const event = parseActivityEvent(request.body);
    if (!event) return response.status(422).json({ error: "invalid_activity_event" });
    if (!vault.get(event.camera_id)) return response.status(404).json({ error: "unknown_camera" });
    const where = event.zone_id ? `zone ${event.zone_id}` : `line ${event.line_id}`;
    const record = (outcome: string): void => audit.record({ action: "ai.activity_event", outcome: "allowed", target: event.camera_id, detail: `${event.type} ${event.label} in ${where}, ${outcome}` });
    if (event.type === "line_cross" || event.type === "zone_exit") { record("recorded"); return response.json({ raised: false, reason: "recorded" }); }
    const zone = context.detectionZones.get(event.camera_id).zones.find(item => item.id === event.zone_id);
    // The review timeline (vision.timeline, off by default) keeps the events of the zones the server knows, with the evidence taken when it was an armed alert.
    const entry = zone ? context.visionTimeline.add({ camera_id: event.camera_id, level: zone.kind === "alert" ? "alert" : "detection", zone_id: zone.id, zone_name: zone.name, label: event.label }) : null;
    if (!zone || zone.kind !== "alert") { record("recorded"); return response.json({ raised: false, reason: "recorded" }); }
    if (event.notify === false) { record("not told, as the profile of the mode says"); return response.json({ raised: false, reason: "notify_off" }); }
    if (store.snapshot().mode !== "armed") { record("disarmed"); return response.json({ raised: false, reason: "disarmed" }); }
    const alarm = alarms.raise(`ai:camera:${event.camera_id}:activity:${zone.id}:${Math.floor(Date.now() / MOTION_WINDOW_MS)}`, {
      source: { type: "camera", id: event.camera_id }, severity: "high", code: "camera_motion",
      detail: { zone: zone.name, label: event.label, ...(event.seconds !== undefined ? { seconds: Math.round(event.seconds) } : {}) }, instant: true,
    });
    const watched = vault.get(event.camera_id);
    if (entry && alarm) context.visionTimeline.setAlarm(entry.id, alarm.id);
    if (watched) void context.captureOnDetect.trigger(watched).then(taken => { if (entry && taken) context.visionTimeline.setEvidence(entry.id, { snapshot_id: taken.snapshot_id ?? null, clip_id: taken.clip_id ?? null }); }).catch(() => undefined);
    record(alarm ? "alarm raised" : "one is already open");
    return response.json({ raised: Boolean(alarm), ...(alarm ? { alarm_id: alarm.id } : { reason: "already_open" }) });
  });
}
