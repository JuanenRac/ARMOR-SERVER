/**
 * The system page: what the server is, how busy and how full it is, and (for an administrator) the audit trail of who did what.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import { checkConnection, readConnection, writeConnection } from "../connection.js";
import { isLoopbackHost } from "../config.js";
import { buildPanelSummary, energySummary } from "../panel_feed.js";
import type { AppContext } from "../context.js";
import { mqttTlsState } from "../mqtt_tls.js";
import { buildPreflight } from "../preflight.js";
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

/**
 * Every line of the audit trail that mentions `containing`, oldest first, from the current file AND the rotated ones (the audit log rotates at 5 MiB and keeps three older files; a
 * proof of custody that read only the end of the current file left out the history of any file older than the last few days). `from` is the time of the oldest line kept at all.
 */
export function auditLinesAbout(dataDir: string, containing: string): { lines: Array<Record<string, unknown>>; from: string | null } {
  const lines: Array<Record<string, unknown>> = [];
  let from: string | null = null;
  for (const name of ["audit.log.3", "audit.log.2", "audit.log.1", "audit.log"]) {
    let text: string;
    try { text = fs.readFileSync(path.join(dataDir, name), "utf8"); } catch { continue; }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (from === null && typeof parsed.at === "string") from = parsed.at;
      if (raw.includes(containing)) lines.push(parsed);
    }
  }
  return { lines, from };
}

export { energySummary };

export function registerSystemRoutes(app: Express, context: AppContext, version: string, readUnits: UnitReader = systemctlReader): void {
  const { config, store, devices, alarms, automations, users, vault, events, evidence, systemMonitor, requireOperator, requireAdmin } = context;
  // How the machine is doing, as a task manager shows it: the latest sample and the last few minutes of it.
  app.get("/api/v1/system/metrics", requireOperator, (_request, response) => response.json({ ...systemMonitor.current, history: systemMonitor.history }));

  // The check before arming: what would leave the perimeter blind or noisy. Read only; the console and the phone ask it before they arm (a wall panel has no access to it: its account may only read the summary, change the mode and acknowledge alarms).
  app.get("/api/v1/preflight", requireOperator, (_request, response) => response.json(buildPreflight({
    nodes: Object.values(store.snapshot().nodes).map(node => ({ node_id: node.node_id, online: node.online })),
    // A panel that was there before the last restart and has not spoken since is as silent as one that went quiet: it is listed here too (it is not in memory to be asked).
    panels: [
      ...context.alarmNodes.list().map(node => ({ node_id: node.node_id, stale: node.stale, open_zones: node.state.open_zones })),
      ...context.knownNodes.silent(config.nodeStaleAfterS * 2000).filter(node => node.kind === "alarm" && !context.alarmNodes.list().some(live => live.node_id === node.id)).map(node => ({ node_id: node.id, stale: true, open_zones: [] as string[] })),
    ],
    cameras: context.cameraWatcher.snapshot().map(camera => ({ id: camera.id, status: camera.status })),
    devices: devices.list().map(device => ({ id: device.id, kind: device.kind, online: device.online, state: device.state as Record<string, unknown>, expected_interval_s: device.expected_interval_s })),
    alarms: alarms.active(),
  })));

  // What the nodes sent that the server took, refused or partly ignored (fields of a newer firmware), per topic, with the start of the last refused message.
  app.get("/api/v1/system/ingest", requireOperator, (_request, response) => response.json({ topics: context.ingestLog.list() }));

  const versionReader = programVersions(version);

  // Every service of the system, running or not: the programs of this machine (from systemd) and the field nodes (from what they last said). Read only.
  app.get("/api/v1/system/services", requireOperator, async (_request, response) => {
    const nodes: FieldNode[] = [
      ...store.wallPanels().map(panel => ({ id: panel.id, kind: "hmi", online: panel.online, last_ms: panel.last_ms || null })),
      ...Object.values(store.snapshot().nodes).map(node => ({ id: node.node_id, kind: "radar", online: node.online, last_ms: node.timestamp_ms || null, firmware: node.panel?.firmware ?? null })),
      ...context.electricalNodes.list().map(node => ({ id: node.node_id, kind: "electrical", online: !node.stale, last_ms: Date.parse(node.received_at) || null })),
      ...context.alarmNodes.list().map(node => ({ id: node.node_id, kind: "alarm", online: !node.stale, last_ms: Date.parse(node.received_at) || null })),
      ...context.networkNodes.list().map(node => ({ id: node.node_id, kind: "network", online: !node.stale, last_ms: Date.parse(node.received_at) || null })),
      // a solar gateway node reports one reading per equipment on its ports: one entry for the node, online while any of its equipment is
      ...[...new Set(context.solar.list().map(item => item.node_id))].map(id => {
        const own = context.solar.list().filter(item => item.node_id === id);
        return { id, kind: "solar", online: own.some(item => !item.stale), last_ms: Math.max(...own.map(item => Date.parse(item.received_at) || 0)) || null };
      }),
    ];
    const { systemd, services } = await listServices(readUnits, nodes, procPausedReader, versionReader);
    response.json({ time_ms: Date.now(), systemd, services });
  });

  // A small summary for the screens that cannot take the whole state (the touch panel, a watch): the mode, how many nodes are there and the alarms that need a person, newest first,
  // the ones nobody has acknowledged first. Always a few hundred bytes, whatever the installation holds.
  app.get("/api/v1/panel/summary", requireOperator, (_request, response) => response.json(buildPanelSummary(context)));

  // Where the server listens and where Studio is served (an administrator). The change is kept in a file and takes effect when the server is started again.
  const connectionState = () => {
    const saved = readConnection(config.dataDir);
    return { active: { host: config.host, port: config.port, tls: Boolean(config.tls), studio_origins: config.studioOrigins }, mqtt_tls: mqttTlsState(config.mqtt), saved, restart_required: (saved.host !== undefined && saved.host !== config.host) || (saved.port !== undefined && saved.port !== config.port) || saved.studio_port !== undefined };
  };
  app.get("/api/v1/system/connection", requireAdmin, (_request, response) => response.json(connectionState()));
  app.put("/api/v1/system/connection", requireAdmin, (request, response) => {
    const checked = checkConnection(request.body);
    if (!checked.ok) return void response.status(400).json({ error: checked.error });
    // The password that counts is the one that works now: the seed of the settings file only while it still signs in (a password changed in Studio replaces it), and the minimum the
    // server asks of every password it takes.
    const seedStillSignsIn = context.users.authenticate(config.studioUsername, config.studioPassword) !== null;
    if (checked.value.host && !isLoopbackHost(checked.value.host) && ((seedStillSignsIn && config.studioPassword.length < 12) || context.users.minPasswordLength < 12)) return void response.status(400).json({ error: "the administrator password must have at least 12 characters before the server is reachable from the network" });
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
