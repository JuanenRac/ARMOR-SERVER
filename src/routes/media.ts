/**
 * Evidence routes: catalogue, playback, protection, chain-of-custody hash and
 * deletion. All of them need an operator.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Request } from "express";
import fs from "node:fs";
import type { AppContext } from "../context.js";
import path from "node:path";
import { mediaKindFrom, type MediaKind } from "../media/evidence.js";
import { buildProof, custodyOf, verifyProof } from "../evidence_proof.js";
import { auditLinesAbout } from "./system.js";
import { auditBetween, buildIncident, MAX_AUDIT, MAX_EVENTS, MAX_FILES, parseWindow, verifyIncident, type IncidentFile } from "../incident_export.js";

const param = (request: Request, name: string): string => {
  const value = request.params[name];
  return typeof value === "string" ? value : "";
};

export function registerMediaRoutes(app: Express, context: AppContext): void {
  const { evidence, audit, requireOperator, requireAdmin } = context;
  /** Who did it, for the audit trail: the Studio user of the session (a token has no name of its own). */
  const who = (request: Request): string | undefined => context.studioUser(request)?.username;

  app.get("/api/v1/media", requireOperator, async (_request, response) =>
    response.json({ items: await evidence.list(), activeCameraIds: evidence.activeCameraIds }));

  app.get("/api/v1/media/:cameraId/:kind/:file", requireOperator, (request, response) => {
    const kind = mediaKindFrom(param(request, "kind"));
    const target = kind ? evidence.file(param(request, "cameraId"), kind, param(request, "file")) : null;
    if (!target || !fs.existsSync(target)) return response.sendStatus(404);
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": kind === "snapshots" ? "image/jpeg" : "video/mp4" });
    fs.createReadStream(target).on("error", () => response.destroy()).pipe(response);
    return undefined;
  });

  app.get("/api/v1/media/:cameraId/:kind/:file/sha256", requireOperator, async (request, response) => {
    const kind = mediaKindFrom(param(request, "kind"));
    const digest = kind ? await evidence.sha256(param(request, "cameraId"), kind, param(request, "file")) : null;
    if (!digest) return response.sendStatus(404);
    audit.record({ actor: who(request), action: "evidence.hash", outcome: "allowed", target: `${param(request, "cameraId")}/${kind}/${param(request, "file")}` });
    return response.json({ sha256: digest });
  });

  // The proofs are signed with a key of their own when the installation has one, else with the camera key (the control token when there is none of those): rotating the control token
  // must not make every proof ever issued unverifiable, so the keys still known are all tried when one is checked.
  const proofKey = context.config.evidenceKey ?? context.config.cameraConfigKey;
  const proofKeys = [...new Set([context.config.evidenceKey, context.config.cameraConfigKey, context.config.controlToken].filter((key): key is string => typeof key === "string" && key !== ""))];

  // A signed proof of custody: the file, its digest now and every line of the audit trail about it. Hand it over with the file; the server can say whether it is genuine (POST /api/v1/media/proof/verify).
  app.get("/api/v1/media/:cameraId/:kind/:file/proof", requireOperator, async (request, response) => {
    const cameraId = param(request, "cameraId"), file = param(request, "file"), kind = mediaKindFrom(param(request, "kind"));
    if (!kind) return response.sendStatus(404);
    const [digest, items] = [await evidence.sha256(cameraId, kind, file), await evidence.list()];
    const item = items.find(entry => entry.cameraId === cameraId && entry.file === file);
    if (!digest || !item) return response.sendStatus(404);
    const target = `${cameraId}/${kind}/${file}`;
    const trail = auditLinesAbout(context.config.dataDir, target);
    audit.record({ actor: who(request), action: "evidence.proof", outcome: "allowed", target });
    return response.json(buildProof(proofKey, { camera: cameraId, kind, name: file, bytes: item.bytes, created_at: item.createdAt, sha256: digest, protected: item.protected }, custodyOf(trail.lines, target), new Date(), { auditFrom: trail.from }));
  });

  // The record of one incident as a single signed document (see incident_export.ts): the events, the audit lines and the evidence files of a window of time (at most a week), for an
  // insurer or the police. An administrator asks for it; it is written in the audit trail. A file bigger than 512 MB is listed without its digest.
  app.get("/api/v1/admin/incident", requireAdmin, async (request, response) => {
    const window = parseWindow(request.query.from, request.query.to);
    if (!window) return response.status(400).json({ error: "invalid_window" });
    const events: Array<Record<string, unknown>> = [];
    let after: number | undefined, eventsTruncated = false;
    for (;;) {
      const page = context.events.list({ since: window.fromMs, until: window.toMs, order: "asc", limit: 200, ...(after === undefined ? {} : { before: after }), everything: true });
      for (const event of page) { if (events.length >= MAX_EVENTS) { eventsTruncated = true; break; } events.push(event as unknown as Record<string, unknown>); }
      if (eventsTruncated || page.length < 200) break;
      after = page[page.length - 1]!.id;
    }
    const catalogue = (await evidence.list()).filter(item => Date.parse(item.createdAt) >= window.fromMs && Date.parse(item.createdAt) <= window.toMs).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const files: IncidentFile[] = [];
    for (const item of catalogue.slice(0, MAX_FILES)) {
      const kind = mediaKindFrom(`${item.kind}s`);   // the catalogue says "snapshot" and "recording"
      const sha256 = kind && item.bytes <= 512 * 1024 * 1024 ? await evidence.sha256(item.cameraId, kind, item.file) : null;
      files.push({ camera: item.cameraId, kind: item.kind, name: item.file, bytes: item.bytes, created_at: item.createdAt, sha256, protected: item.protected });
    }
    const trail = auditBetween(context.config.dataDir, window.fromMs, window.toMs, MAX_AUDIT);
    audit.record({ actor: who(request), action: "incident.export", outcome: "allowed", detail: `${events.length} events, ${trail.lines.length} audit lines, ${files.length} files` });
    response.set({ "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="armor-incident.json"' });
    return response.json(buildIncident(proofKey, { fromMs: window.fromMs, toMs: window.toMs, events, eventsTruncated, audit: trail, files, filesTruncated: catalogue.length > MAX_FILES }));
  });

  const incidentJson = express.json({ limit: 12 * 1024 * 1024, type: "application/json" });
  app.post("/api/v1/admin/incident/verify", requireAdmin, incidentJson, async (request, response) => {
    const incident = request.body;
    if (!verifyIncident(proofKeys, incident)) return response.json({ genuine: false, files_match: false });
    let matches = true;
    for (const file of incident.files.slice(0, MAX_FILES)) {
      const kind = mediaKindFrom(`${file.kind}s`);
      const digest = kind ? await evidence.sha256(file.camera, kind, file.name) : null;
      if (file.sha256 !== null && digest !== file.sha256) matches = false;
    }
    return response.json({ genuine: true, files_match: matches, issued_at: incident.issued_at });
  });

  app.post("/api/v1/media/proof/verify", requireOperator, async (request, response) => {
    const proof = request.body;
    if (!verifyProof(proofKeys, proof)) return response.json({ genuine: false, matches: false });
    const kind = mediaKindFrom(proof.file.kind);
    const digest = kind ? await evidence.sha256(proof.file.camera, kind, proof.file.name) : null;
    return response.json({ genuine: true, matches: digest !== null && digest === proof.file.sha256, issued_at: proof.issued_at });
  });

  app.put("/api/v1/media/:cameraId/:kind/:file/protected", requireOperator, (request, response) => {
    const kind = mediaKindFrom(param(request, "kind"));
    if (typeof request.body?.protected !== "boolean") return response.status(400).json({ error: "protected must be true or false" });
    if (!kind || !evidence.setProtected(param(request, "cameraId"), kind, param(request, "file"), request.body.protected)) return response.sendStatus(404);
    audit.record({ actor: who(request), action: request.body.protected ? "evidence.protect" : "evidence.unprotect", outcome: "allowed", target: `${param(request, "cameraId")}/${kind}/${param(request, "file")}` });
    return response.sendStatus(204);
  });

  app.delete("/api/v1/media/:cameraId/:kind/:file", requireOperator, (request, response) => {
    const kind = mediaKindFrom(param(request, "kind"));
    const cameraId = param(request, "cameraId");
    const file = param(request, "file");
    if (!kind) return response.sendStatus(404);
    const item = evidence.item(cameraId, kind, file);
    if (item?.protected) return response.status(409).json({ error: "this evidence is protected; remove its protection first" });
    if (!evidence.remove(cameraId, kind, file)) return response.sendStatus(404);
    audit.record({ actor: who(request), action: "evidence.delete", outcome: "allowed", target: `${cameraId}/${kind}/${file}` });
    return response.sendStatus(204);
  });

  // Erasing ALL the recordings is an administrator's: they are evidence.
  app.delete("/api/v1/media", requireAdmin, async (request, response) => {
    const requested = request.body?.kind;
    const kinds: MediaKind[] = requested === "snapshot" ? ["snapshots"] : requested === "recording" ? ["recordings"] : requested === "all" ? ["snapshots", "recordings"] : [];
    if (!kinds.length) return response.status(400).json({ error: "kind must be snapshot, recording, or all" });
    const deleted = await evidence.removeAll(kinds);
    audit.record({ actor: who(request), action: "evidence.delete-all", outcome: "allowed", detail: `${requested}: ${deleted}` });
    return response.json({ deleted });
  });
}
