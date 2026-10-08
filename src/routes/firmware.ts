/**
 * Firmware of the field nodes, from Studio: upload an image (or take the newest release of the node's repository on GitHub) and update one node, or every node of a kind,
 * one at a time, with the login of the nodes' own panel - used for the job only, never kept and never written in the audit trail. Administrators only.
 * See ../firmware.ts for how a node is updated.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express, type Request } from "express";
import type { AppContext } from "../context.js";
import { FirmwareError, MAX_IMAGE_BYTES, NODE_KINDS, type NodeKind } from "../firmware.js";

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registerFirmwareRoutes(app: Express, context: AppContext): void {
  const { firmware, audit, requireAdmin, studioUser } = context;
  const actor = (request: Request) => studioUser(request)?.username;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null && !Buffer.isBuffer(request.body) ? request.body as Record<string, unknown> : {});
  // A node's panel is on the local network, on port 80; the loopback address is for tests only (they set ARMOR_ADMIN_NODE_PORT).
  const testPort = () => (process.env.ARMOR_ADMIN_NODE_PORT ? Number(process.env.ARMOR_ADMIN_NODE_PORT) : 0);
  const allowedAddress = (address: unknown): address is string => typeof address === "string" && (PRIVATE_V4.test(address) || (testPort() > 0 && address === "127.0.0.1"));
  const kindOf = (value: unknown): NodeKind | undefined => (NODE_KINDS as readonly string[]).includes(String(value)) ? String(value) as NodeKind : undefined;
  const fail = (error: unknown): { status: number; error: string } => {
    const code = error instanceof FirmwareError ? error.code : "failed";
    return { status: code === "job_running" ? 409 : code === "github_unreachable" || code.startsWith("github_http") ? 502 : code === "no_release" ? 404 : 422, error: code };
  };

  app.post("/api/v1/admin/firmware/uploads", requireAdmin, express.raw({ type: "application/octet-stream", limit: MAX_IMAGE_BYTES + 1024 }), (request, response) => {
    if (!Buffer.isBuffer(request.body)) return response.status(415).json({ error: "send_the_bin_as_octet_stream" });
    try {
      const info = firmware.addUpload(request.body, String(request.header("x-firmware-name") ?? ""));
      audit.record({ action: "admin.firmware.upload", outcome: "allowed", actor: actor(request), target: info.name, detail: `${info.bytes} bytes` });
      return response.status(201).json(info);
    } catch (error) { const { status, error: code } = fail(error); return response.status(status).json({ error: code }); }
  });

  app.get("/api/v1/admin/firmware/releases/:kind", requireAdmin, async (request, response) => {
    const kind = kindOf(request.params.kind);
    if (!kind) return response.status(404).json({ error: "unknown_kind" });
    try { return response.json(await firmware.releaseInfo(kind)); }
    catch (error) { const { status, error: code } = fail(error); return response.status(status).json({ error: code }); }
  });

  /** What each node says about itself (its id, version and board), for the list of nodes to update. */
  app.post("/api/v1/admin/firmware/probe", requireAdmin, async (request, response) => {
    const addresses = body(request).addresses;
    if (!Array.isArray(addresses) || addresses.length > 40 || !addresses.every(allowedAddress)) return response.status(422).json({ error: "invalid_address" });
    return response.json({ nodes: await Promise.all(addresses.map(address => firmware.probe(address))) });
  });

  app.post("/api/v1/admin/firmware/jobs", requireAdmin, (request, response) => {
    const input = body(request);
    const kind = kindOf(input.kind);
    if (!kind) return response.status(422).json({ error: "unknown_kind" });
    const source = input.source === "github" || input.source === "upload" ? input.source : undefined;
    if (!source) return response.status(422).json({ error: "unknown_source" });
    const targets = Array.isArray(input.targets) ? input.targets as Array<{ address?: unknown; node_id?: unknown }> : [];
    if (targets.length < 1 || targets.length > 20 || !targets.every(item => allowedAddress(item?.address))) return response.status(422).json({ error: "invalid_address" });
    const user = typeof input.panel_user === "string" ? input.panel_user : "", password = typeof input.panel_password === "string" ? input.panel_password : "";
    if (!user || !password || user.length > 64 || password.length > 128) return response.status(422).json({ error: "no_panel_login" });
    try {
      const job = firmware.start({
        kind, source, uploadId: typeof input.upload_id === "string" ? input.upload_id : undefined,
        targets: targets.map(item => ({ address: String(item.address), ...(typeof item.node_id === "string" && NODE_ID.test(item.node_id) ? { node_id: item.node_id } : {}) })),
        login: { user, password },
        onNode: (finished, target) => audit.record({ action: "admin.firmware.node", outcome: target.state === "done" ? "allowed" : "failed", actor: actor(request), target: target.node_id ?? target.address, detail: `${finished.kind} ${target.version_before ?? "?"} -> ${target.version_after ?? "?"}${target.error ? ` (${target.error})` : ""}` }),
      });
      audit.record({ action: "admin.firmware.start", outcome: "allowed", actor: actor(request), target: kind, detail: `${source}, ${targets.length} node(s)` });
      return response.status(202).json({ id: job.id });
    } catch (error) { const { status, error: code } = fail(error); return response.status(status).json({ error: code }); }
  });

  app.get("/api/v1/admin/firmware/jobs/:id", requireAdmin, (request, response) => {
    const job = firmware.job(String(request.params.id));
    if (!job) return response.status(404).json({ error: "unknown_job" });
    response.setHeader("Cache-Control", "no-store");
    return response.json(job);
  });
}
