/**
 * The system page: what the server is, how busy and how full it is, and (for an administrator) the audit trail of who did what.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import type { AppContext } from "../context.js";

/** The last `limit` lines of a text file, without reading all of a large one. */
export function tailLines(file: string, limit: number, maxBytes = 512 * 1024): string[] {
  try {
    const size = fs.statSync(file).size, start = Math.max(0, size - maxBytes), descriptor = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n").filter(Boolean);
      if (start > 0) lines.shift();          // the first line may be cut in two
      return lines.slice(-limit);
    } finally { fs.closeSync(descriptor); }
  } catch { return []; }
}

export function registerSystemRoutes(app: Express, context: AppContext, version: string): void {
  const { config, store, devices, alarms, automations, users, vault, events, evidence, systemMonitor, requireOperator, requireAdmin } = context;
  // How the machine is doing, as a task manager shows it: the latest sample and the last few minutes of it.
  app.get("/api/v1/system/metrics", requireOperator, (_request, response) => response.json({ ...systemMonitor.current, history: systemMonitor.history }));

  app.get("/api/v1/system", requireOperator, async (_request, response) => {
    const state = store.snapshot(), nodes = Object.values(state.nodes), all = devices.list();
    let mediaBytes = 0, mediaFiles = 0;
    try { const media = await evidence.list(); mediaFiles = media.length; mediaBytes = media.reduce((sum, item) => sum + item.bytes, 0); } catch { /* an unreadable library is shown as empty */ }
    let disk: { free_bytes: number; total_bytes: number } | null = null;
    try { const stats = fs.statfsSync(config.dataDir); disk = { free_bytes: stats.bavail * stats.bsize, total_bytes: stats.blocks * stats.bsize }; } catch { /* not available on this platform */ }
    response.json({
      service: "armor-server", version, node: process.version, uptime_s: Math.round(process.uptime()), mode: state.mode, revision: state.revision,
      mqtt: Boolean(config.mqtt), live_video: Boolean(config.ffmpegPath), webhook: Boolean(config.alertWebhookUrl), cameras_check_s: config.cameraCheckS,
      counts: {
        nodes: nodes.length, nodes_online: nodes.filter(node => node.online && !node.stale).length,
        cameras: vault.list().length, devices: all.length, devices_online: all.filter(device => device.online).length,
        alarms_active: alarms.active().length, automations: automations.list().length, users: users.list().length, events: events.summary().total,
      },
      storage: { media_files: mediaFiles, media_bytes: mediaBytes, media_limit_bytes: config.maxMediaBytes, disk },
    });
  });

  // Who did what: an administrator reads the audit trail (never a secret: it is scrubbed as it is written).
  app.get("/api/v1/audit", requireAdmin, (request, response) => {
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(request.query.limit ?? 100)) || 100));
    const entries = tailLines(path.join(config.dataDir, "audit.log"), limit).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
    response.json({ entries: entries.reverse() });
  });
}
