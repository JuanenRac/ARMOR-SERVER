/**
 * The local network as the ARMOR-NETWORK nodes see it: the state the nodes send over HTTP (over MQTT it arrives in app.ts), what Studio and the phone read (the devices with the
 * names an operator gave them, the internet, the events, the outages, the history), the notes an operator keeps about a device, and the network design drawn in Studio's Network
 * Designer. Observation only: nothing here sends anything to a node or to a device of the network.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { NoteInvalid, parseNetworkMessage } from "../network.js";
import { MAX_SITE_BYTES, SiteConflict, SiteInvalid } from "../site.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

export function registerNetworkRoutes(app: Express, context: AppContext): void {
  const { config, networkNodes, networkNotes, network, alarmRules, audit, requireOperator, requireAdmin, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 1_200, standardHeaders: "draft-8", legacyHeaders: false });
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});

  app.post("/api/v1/network/state", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      networkNodes.ingest(parseNetworkMessage(request.body));
      return response.status(202).json({ accepted: true });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid network message" }); }
  });

  // What an operator sees: every node with its devices (each with the note an operator gave it, if any), the sums, the latest events and the outages.
  app.get("/api/v1/network", requireOperator, (_request, response) => {
    const notes = networkNotes.all();
    const nodes = networkNodes.list().map(view => ({
      node_id: view.node_id, received_at: view.received_at, stale: view.stale, interface: view.state.interface, internet: view.state.internet, ...(view.state.scan ? { scan: view.state.scan } : {}),
      devices: view.state.devices.map(device => ({ ...device, ...(notes[device.id] ? { note: notes[device.id] } : {}) })),
    }));
    response.json({ nodes, totals: networkNodes.totals(), events: networkNodes.events(100), outages: networkNodes.outages().slice(0, 50) });
  });

  app.get("/api/v1/network/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    if (!NODE.test(node)) return response.status(400).json({ error: "node is required" });
    const asked = Number(request.query.minutes ?? 60);
    const minutes = Number.isFinite(asked) ? Math.min(1440, Math.max(1, Math.round(asked))) : 60;
    const samples = networkNodes.history(node, minutes);
    if (!samples) return response.status(404).json({ error: "unknown network node" });
    return response.json({ node_id: node, minutes, samples });
  });

  // The names, notes and "known" marks of the devices. Marking a device as known is a decision about security (it silences the alarm of a new device), so it is an administrator's.
  app.put("/api/v1/network/devices/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    if (!DEVICE.test(id)) return response.status(400).json({ error: "invalid device id", code: "invalid_device" });
    try {
      const note = networkNotes.set(id, body(request));
      if (note.trusted) alarmRules.handleNetworkTrust(id);
      audit.record({ action: "network.device", outcome: "allowed", actor: actor(request), target: id, detail: `${note.trusted ? "known" : "not marked as known"}${note.name ? `, named ${note.name}` : ""}` });
      return response.json({ id, note });
    } catch (error) {
      if (error instanceof NoteInvalid || error instanceof Error) return response.status(400).json({ error: error.message, code: "invalid_note" });
      return response.status(500).json({ error: "internal error" });
    }
  });

  app.delete("/api/v1/network/devices/:id", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    if (!DEVICE.test(id)) return response.status(400).json({ error: "invalid device id", code: "invalid_device" });
    const removed = networkNotes.remove(id);
    audit.record({ action: "network.device.forget", outcome: removed ? "allowed" : "failed", actor: actor(request), target: id });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "nothing was kept about that device", code: "not_found" });
  });

  // ---- the network design (the house's network drawn in Studio's Network Designer) ----
  const bigJson = express.json({ limit: MAX_SITE_BYTES + 4096, type: "application/json" });
  const view = (doc: ReturnType<typeof network.get>) => ({ revision: doc.revision, updated_at: doc.updated_at, updated_by: doc.updated_by, network: doc.site });
  app.get("/api/v1/network/design", requireOperator, (_request, response) => response.json(view(network.get())));
  app.put("/api/v1/network/design", requireOperator, bigJson, (request, response) => {
    const input = body(request);
    try {
      const saved = network.save(input.network, input.revision, actor(request));
      audit.record({ action: "network.save", outcome: "allowed", actor: actor(request), detail: `revision ${saved.revision}` });
      return response.json({ revision: saved.revision, updated_at: saved.updated_at, updated_by: saved.updated_by });
    } catch (error) {
      if (error instanceof SiteConflict) return response.status(409).json({ error: error.message, code: "conflict", current: view(error.current) });
      if (error instanceof SiteInvalid) return response.status(400).json({ error: error.message, code: "invalid_network" });
      return response.status(500).json({ error: "internal error" });
    }
  });
}
