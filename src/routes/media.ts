/**
 * Evidence routes: catalogue, playback, protection, chain-of-custody hash and
 * deletion. All of them need an operator.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Request } from "express";
import fs from "node:fs";
import type { AppContext } from "../context.js";
import { mediaKindFrom, type MediaKind } from "../media/evidence.js";

const param = (request: Request, name: string): string => {
  const value = request.params[name];
  return typeof value === "string" ? value : "";
};

export function registerMediaRoutes(app: Express, context: AppContext): void {
  const { evidence, audit, requireOperator } = context;

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
    audit.record({ action: "evidence.hash", outcome: "allowed", target: `${param(request, "cameraId")}/${kind}/${param(request, "file")}` });
    return response.json({ sha256: digest });
  });

  app.put("/api/v1/media/:cameraId/:kind/:file/protected", requireOperator, (request, response) => {
    const kind = mediaKindFrom(param(request, "kind"));
    if (typeof request.body?.protected !== "boolean") return response.status(400).json({ error: "protected must be true or false" });
    if (!kind || !evidence.setProtected(param(request, "cameraId"), kind, param(request, "file"), request.body.protected)) return response.sendStatus(404);
    audit.record({ action: request.body.protected ? "evidence.protect" : "evidence.unprotect", outcome: "allowed", target: `${param(request, "cameraId")}/${kind}/${param(request, "file")}` });
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
    audit.record({ action: "evidence.delete", outcome: "allowed", target: `${cameraId}/${kind}/${file}` });
    return response.sendStatus(204);
  });

  app.delete("/api/v1/media", requireOperator, async (request, response) => {
    const requested = request.body?.kind;
    const kinds: MediaKind[] = requested === "snapshot" ? ["snapshots"] : requested === "recording" ? ["recordings"] : requested === "all" ? ["snapshots", "recordings"] : [];
    if (!kinds.length) return response.status(400).json({ error: "kind must be snapshot, recording, or all" });
    const deleted = await evidence.removeAll(kinds);
    audit.record({ action: "evidence.delete-all", outcome: "allowed", detail: `${requested}: ${deleted}` });
    return response.json({ deleted });
  });
}
