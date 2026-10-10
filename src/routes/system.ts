/**
 * The system page: what the server is, how busy and how full it is, and (for an administrator) the audit trail of who did what.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { checkConnection, readConnection, writeConnection } from "../connection.js";
import { isLoopbackHost } from "../config.js";
import type { AppContext } from "../context.js";
import { listServices, procPausedReader, programVersions, systemctlReader, type FieldNode, type UnitReader } from "../services.js";

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

export function registerSystemRoutes(app: Express, context: AppContext, version: string, readUnits: UnitReader = systemctlReader): void {
  const { config, store, devices, alarms, automations, users, vault, events, evidence, systemMonitor, requireOperator, requireAdmin } = context;
  // How the machine is doing, as a task manager shows it: the latest sample and the last few minutes of it.
  app.get("/api/v1/system/metrics", requireOperator, (_request, response) => response.json({ ...systemMonitor.current, history: systemMonitor.history }));

  // What the nodes sent that the server took, refused or partly ignored (fields of a newer firmware), per topic, with the start of the last refused message.
  app.get("/api/v1/system/ingest", requireOperator, (_request, response) => response.json({ topics: context.ingestLog.list() }));

  const versionReader = programVersions(version);

  // Every service of the system, running or not: the programs of this machine (from systemd) and the field nodes (from what they last said). Read only.
  app.get("/api/v1/system/services", requireOperator, async (_request, response) => {
    const nodes: FieldNode[] = [
      ...Object.values(store.snapshot().nodes).map(node => ({ id: node.node_id, kind: "radar", online: node.online, last_ms: node.timestamp_ms || null, firmware: node.panel?.firmware ?? null })),
      ...context.electricalNodes.list().map(node => ({ id: node.node_id, kind: "electrical", online: !node.stale, last_ms: Date.parse(node.received_at) || null })),
    ];
    const { systemd, services } = await listServices(readUnits, nodes, procPausedReader, versionReader);
    response.json({ time_ms: Date.now(), systemd, services });
  });

  // A small summary for the screens that cannot take the whole state (the touch panel, a watch): the mode, how many nodes are there and the alarms that need a person, newest first,
  // the ones nobody has acknowledged first. Always a few hundred bytes, whatever the installation holds.
  app.get("/api/v1/panel/summary", requireOperator, (_request, response) => {
    const state = store.snapshot(), nodes = Object.values(state.nodes), active = alarms.active();
    const order = [...active].sort((a, b) => Number(Boolean(a.acknowledged_at)) - Number(Boolean(b.acknowledged_at)) || b.raised_at.localeCompare(a.raised_at));
    response.json({
      mode: state.mode, revision: state.revision, time_ms: Date.now(),
      nodes: { online: nodes.filter(node => node.online).length, total: nodes.length },
      alarms: {
        active: active.length, unacknowledged: active.filter(alarm => !alarm.acknowledged_at).length,
        items: order.slice(0, 6).map(alarm => ({ id: alarm.id, code: alarm.code, severity: alarm.severity, source_type: alarm.source.type, source_id: alarm.source.id.slice(0, 48), raised_at: alarm.raised_at, acknowledged: Boolean(alarm.acknowledged_at) })),
      },
    });
  });

  // Where the server listens and where Studio is served (an administrator). The change is kept in a file and takes effect when the server is started again.
  const connectionState = () => {
    const saved = readConnection(config.dataDir);
    return { active: { host: config.host, port: config.port, tls: Boolean(config.tls), studio_origins: config.studioOrigins }, saved, restart_required: (saved.host !== undefined && saved.host !== config.host) || (saved.port !== undefined && saved.port !== config.port) || saved.studio_port !== undefined };
  };
  app.get("/api/v1/system/connection", requireAdmin, (_request, response) => response.json(connectionState()));
  app.put("/api/v1/system/connection", requireAdmin, (request, response) => {
    const checked = checkConnection(request.body);
    if (!checked.ok) return void response.status(400).json({ error: checked.error });
    if (checked.value.host && !isLoopbackHost(checked.value.host) && config.studioPassword.length < 12) return void response.status(400).json({ error: "the administrator password must have at least 12 characters before the server is reachable from the network" });
    writeConnection(config.dataDir, checked.value);
    context.audit.record({ action: "system.connection", outcome: "allowed", actor: context.studioUser(request)?.username ?? "admin", detail: JSON.stringify(checked.value) });
    response.json(connectionState());
  });

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
