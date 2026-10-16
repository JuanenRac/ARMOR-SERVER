/**
 * Camera routes: configuration, discovery, PTZ, live video and evidence
 * capture. Every route that configures, moves, captures or records needs an
 * operator; live video also accepts a short-lived camera-bound ticket.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { CaptureSettingsInvalid } from "../capture_on_detect.js";
import { IgnoreZonesInvalid } from "../ignore_zones.js";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { discoveryPrefixes, scanNetworks } from "../cameras/discovery.js";
import { clientMessage } from "../cameras/errors.js";
import { parseCameraInput, type CameraConnection } from "../cameras/model.js";
import { discoverRtspPaths } from "../cameras/rtsp.js";

/** The paths that cameras of the common families give to their lighter second stream (Hi3510 12, Hikvision 102, Dahua subtype 1). */
const SUB_STREAM = /^\/(12|13|stream2)$|Channels\/(2|102|202)$|subtype=1/;

const param = (request: Request, name: string): string => {
  const value = request.params[name];
  return typeof value === "string" ? value : "";
};

export function registerCameraRoutes(app: Express, context: AppContext): void {
  const { config, vault, evidence, relays, tickets, discovery, audit, requireOperator, operatorAuthorized } = context;
  /** Who did it, for the audit trail: the Studio user of the session (a token has no name of its own). */
  const who = (request: Request): string | undefined => context.studioUser(request)?.username;
  // A held PTZ button repeats its command every second, so movement has a budget of its own.
  const ptzLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false });
  const lastPtzAudit = new Map<string, number>();
  const sensitiveLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

  // The parts of the picture that the observation service must not look at (a tree, a road, a screen): rectangles in fractions of the picture, set by an administrator.
  app.get("/api/v1/cameras/:id/ignore-zones", requireOperator, (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return undefined;
    return response.json({ camera_id: camera.id, zones: context.ignoreZones.get(camera.id) });
  });
  app.put("/api/v1/cameras/:id/ignore-zones", context.requireAdmin, (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return undefined;
    try {
      const zones = context.ignoreZones.set(camera.id, (request.body as { zones?: unknown } | undefined)?.zones);
      audit.record({ actor: who(request), action: "camera.ignore_zones", outcome: "allowed", target: camera.id, detail: `${zones.length} zone(s)` });
      return response.json({ camera_id: camera.id, zones });
    } catch (error) {
      if (error instanceof IgnoreZonesInvalid) return response.status(400).json({ error: error.message });
      throw error;
    }
  });

  // What the server keeps by itself when a camera sees something while the perimeter is armed (see ../capture_on_detect.ts): anybody who may look reads it, an administrator sets it.
  app.get("/api/v1/capture-settings", requireOperator, (_request, response) => response.json({ settings: context.captureOnDetect.get(), recent: context.captureOnDetect.recent() }));
  app.put("/api/v1/capture-settings", context.requireAdmin, (request, response) => {
    try {
      const settings = context.captureOnDetect.set(request.body);
      audit.record({ actor: who(request), action: "evidence.auto_capture.settings", outcome: "allowed", target: settings.enabled ? "on" : "off" });
      return response.json({ settings });
    } catch (error) {
      if (error instanceof CaptureSettingsInvalid) return response.status(400).json({ error: error.message });
      throw error;
    }
  });
  const withCamera = (request: Request, response: Response): CameraConnection | null => {
    const camera = vault.get(param(request, "id"));
    if (!camera) { response.sendStatus(404); return null; }
    return camera;
  };

  // Needs an operator: the inventory of the cameras (address, ports, paths and, on many cheap cameras, a snapshot URL that carries the login) is not for whoever is on the LAN.
  app.get("/api/v1/camera-views", requireOperator, (_request, response) => response.json({ cameras: vault.list().map(context.viewCamera) }));
  app.get("/api/v1/cameras", requireOperator, (_request, response) => response.json({ cameras: vault.list().map(context.publicCamera) }));

  app.post("/api/v1/cameras/configure", requireOperator, (request, response) => {
    const existing = typeof request.body?.id === "string" ? vault.get(request.body.id.trim()) : undefined;
    const camera = parseCameraInput(request.body, existing);
    if (!camera) return response.status(400).json({ error: "invalid camera configuration" });
    vault.save(camera);
    relays.stop(camera.id); // a changed address or credential must not keep an old stream alive
    audit.record({ actor: who(request), action: "camera.configure", outcome: "allowed", target: camera.id });
    return response.json(context.publicCamera(camera));
  });

  app.delete("/api/v1/cameras/:id", requireOperator, (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return undefined;
    if (evidence.isRecording(camera.id)) return response.status(409).json({ error: "stop the active recording before removing this camera" });
    relays.stop(camera.id);
    vault.remove(camera.id);
    context.ignoreZones.forget(camera.id);
    audit.record({ actor: who(request), action: "camera.remove", outcome: "allowed", target: camera.id });
    // Evidence is kept: removing a connection must never erase footage without a separate, explicit action.
    return response.sendStatus(204);
  });

  app.post("/api/v1/cameras/discover", requireOperator, sensitiveLimit, async (request, response) => {
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const prefixes = discoveryPrefixes(config.discoveryCidr);
      audit.record({ actor: who(request), action: "camera.discover", outcome: "allowed", detail: prefixes.map(prefix => `${prefix}.0/24`).join(",") });
      const result = await discovery.run(() => scanNetworks({ prefixes, signal: controller.signal }));
      if (result === "busy") return response.status(429).json({ error: "a camera discovery is already running" });
      return response.json({ cameras: result, scanned: prefixes.map(prefix => `${prefix}.0/24`) });
    } catch (error) {
      return response.status(400).json({ error: clientMessage(error, "camera discovery unavailable") });
    }
  });

  app.post("/api/v1/cameras/:id/ptz", requireOperator, ptzLimit, async (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return;
    try {
      await context.ptz.move(camera, request.body?.command);
      // Audit a movement when it starts, not every repeat of a held button.
      const now = Date.now();
      if (now - (lastPtzAudit.get(camera.id) ?? 0) > 5_000 || request.body?.command === "stop") {
        lastPtzAudit.set(camera.id, now);
        audit.record({ actor: who(request), action: "camera.ptz", outcome: "allowed", target: camera.id, detail: String(request.body?.command) });
      }
      response.json({ camera: context.publicCamera(camera), command: request.body?.command });
    } catch (error) {
      audit.record({ actor: who(request), action: "camera.ptz", outcome: "failed", target: camera.id });
      response.status(502).json({ error: clientMessage(error, "PTZ operation failed") });
    }
  });

  app.post("/api/v1/cameras/:id/discover-rtsp", requireOperator, sensitiveLimit, async (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return;
    if (!camera.secrets?.username || !camera.secrets.password) return response.status(409).json({ error: "complete camera credentials are required" });
    const paths = await discoverRtspPaths(camera);
    if (paths[0]) {
      camera.rtspPath = paths[0].replace(/^\/+/, "");
      // The same camera usually offers a lighter second stream; the live picture of the console uses it and the recordings keep the main one.
      const light = paths.find(path => path !== paths[0] && SUB_STREAM.test(path));
      if (light) camera.previewPath = light.replace(/^\/+/, "");
      vault.save(camera);
    }
    audit.record({ actor: who(request), action: "camera.discover-rtsp", outcome: "allowed", target: camera.id, detail: `${paths.length} path(s)` });
    return response.json({ paths, camera: context.publicCamera(camera) });
  });

  // A ticket lets an <img> tag load a stream without any header. Only an operator can obtain one.
  app.post("/api/v1/cameras/:id/stream-ticket", requireOperator, (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return;
    relays.warm(camera);
    const grant = tickets.issue(camera.id);
    return response.status(201).json({ path: `/api/v1/cameras/${encodeURIComponent(camera.id)}/mjpeg?ticket=${encodeURIComponent(grant.ticket)}`, expiresAt: grant.expiresAt });
  });

  app.get("/api/v1/cameras/:id/mjpeg", (request, response) => {
    const camera = vault.get(param(request, "id"));
    if (!camera) return response.sendStatus(404);
    if (!operatorAuthorized(request) && !tickets.valid(request.query.ticket, camera.id)) {
      audit.record({ actor: who(request), action: "camera.stream", outcome: "denied", target: camera.id });
      return response.status(401).json({ error: "operator authorization or a stream ticket is required" });
    }
    try {
      response.status(200).set({ "Cache-Control": "no-store", Connection: "keep-alive", "Content-Type": "multipart/x-mixed-replace; boundary=armorframe" });
      const detach = relays.attach(camera, response);
      request.once("close", detach);
      return undefined;
    } catch (error) {
      return response.status(503).json({ error: clientMessage(error, "live-video relay unavailable") });
    }
  });

  app.post("/api/v1/cameras/:id/snapshot", requireOperator, sensitiveLimit, async (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return;
    try {
      const item = await evidence.snapshot(camera);
      audit.record({ actor: who(request), action: "evidence.snapshot", outcome: "allowed", target: item.id });
      response.status(201).json({ item });
    } catch (error) {
      audit.record({ actor: who(request), action: "evidence.snapshot", outcome: "failed", target: camera.id });
      response.status(502).json({ error: clientMessage(error, "snapshot failed") });
    }
  });

  app.post("/api/v1/cameras/:id/recordings/start", requireOperator, sensitiveLimit, async (request, response) => {
    const camera = withCamera(request, response);
    if (!camera) return;
    try {
      const started = await evidence.startRecording(camera);
      audit.record({ actor: who(request), action: "evidence.record.start", outcome: "allowed", target: camera.id });
      response.status(202).json({ cameraId: started.cameraId, recording: true, startedAt: started.startedAt });
    } catch (error) {
      audit.record({ actor: who(request), action: "evidence.record.start", outcome: "failed", target: camera.id });
      response.status(502).json({ error: clientMessage(error, "recording could not start") });
    }
  });

  app.post("/api/v1/cameras/:id/recordings/stop", requireOperator, async (request, response) => {
    const cameraId = param(request, "id");
    if (!evidence.isRecording(cameraId)) return response.status(409).json({ error: "camera is not recording" });
    try {
      const item = await evidence.stopRecording(cameraId);
      audit.record({ actor: who(request), action: "evidence.record.stop", outcome: "allowed", target: item.id });
      return response.json({ item });
    } catch (error) {
      audit.record({ actor: who(request), action: "evidence.record.stop", outcome: "failed", target: cameraId });
      return response.status(502).json({ error: clientMessage(error, "recording could not be finalized") });
    }
  });
}
