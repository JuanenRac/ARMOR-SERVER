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
import { CommandInvalid } from "../network_commands.js";
import { CredentialsInvalid } from "../device_credentials.js";
import { MAX_SITE_BYTES, SiteConflict, SiteInvalid } from "../site.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

export function registerNetworkRoutes(app: Express, context: AppContext): void {
  const { config, networkNodes, networkNotes, networkCommands, deviceCredentials, network, alarmRules, audit, requireOperator, requireAdmin, studioUser } = context;
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 1_200, standardHeaders: "draft-8", legacyHeaders: false });
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const body = (request: { body?: unknown }): Record<string, unknown> => (typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});

  app.post("/api/v1/network/state", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      const message = parseNetworkMessage(request.body);
      networkNodes.ingest(message);
      networkCommands.record(message.node_id, message.results);
      // The answer carries the manual orders waiting for this node (handed out once); a node that does not look for them simply ignores the field.
      const commands = networkCommands.take(message.node_id).map(command => {
        if (!command.login || !command.device_id) return command;
        const login = deviceCredentials.get(command.device_id);
        const { login: _asked, ...rest } = command;
        return login ? { ...rest, auth: { user: login.user, password: login.password } } : rest;   // without a login kept, the node looks without one
      });
      return response.status(202).json({ accepted: true, commands });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "invalid network message" }); }
  });

  // What an operator sees: every node with its devices (each with the note an operator gave it, if any), the sums, the latest events and the outages.
  app.get("/api/v1/network", requireOperator, (request, response) => {
    const notes = networkNotes.all();
    const showHidden = request.query.hidden === "1";
    const nodes = networkNodes.list().map(view => ({
      node_id: view.node_id, received_at: view.received_at, stale: view.stale, interface: view.state.interface, internet: view.state.internet, ...(view.state.scan ? { scan: view.state.scan } : {}),
      ...(view.state.public ? { public: view.state.public } : {}),
      devices: view.state.devices.filter(device => showHidden || !notes[device.id]?.hidden).map(device => ({ ...device, ...(notes[device.id] ? { note: notes[device.id] } : {}), ...(deviceCredentials.summary(device.id) ? { login: deviceCredentials.summary(device.id) } : {}) })),
      hidden: view.state.devices.filter(device => notes[device.id]?.hidden).length,
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

  // ---- manual orders for a node: a sweep now, a ping, a traceroute, a wake-up, the ports or the web page of one device ----
  const commandLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "too many orders" } });
  const commandView = (record: ReturnType<typeof networkCommands.get>) => record && ({ id: record.command.id, node_id: record.node_id, type: record.command.type, device_id: record.command.device_id, status: record.status, by: record.by, created_at: record.created_at, ...(record.result ? { result: record.result } : {}) });
  app.post("/api/v1/network/commands", requireOperator, commandLimit, (request, response) => {
    const input = body(request);
    const nodes = networkNodes.list();
    const nodeId = typeof input.node_id === "string" ? input.node_id : nodes[0]?.node_id;
    const node = nodes.find(item => item.node_id === nodeId);
    if (!node) return response.status(404).json({ error: "no such network node", code: "unknown_node" });
    if (node.stale) return response.status(409).json({ error: "the network node is not reporting", code: "node_offline" });
    const deviceId = typeof input.device_id === "string" ? input.device_id : "";
    if (deviceId && !DEVICE.test(deviceId)) return response.status(400).json({ error: "invalid device id", code: "invalid_device" });
    if (input.type === "inspect" && input.login === true && !deviceCredentials.summary(deviceId)) return response.status(409).json({ error: "no login is kept for that device", code: "no_login" });
    try {
      const record = networkCommands.enqueue(node.node_id, input, deviceId ? networkNodes.device(node.node_id, deviceId) : undefined, actor(request));
      audit.record({ action: "network.command", outcome: "allowed", actor: actor(request), target: `${node.node_id}/${record.command.device_id ?? "-"}`, detail: record.command.type });
      return response.status(202).json(commandView(record));
    } catch (error) {
      if (error instanceof CommandInvalid) return response.status(400).json({ error: error.message, code: error.code });
      return response.status(500).json({ error: "internal error" });
    }
  });
  app.get("/api/v1/network/commands", requireOperator, (_request, response) => response.json({ commands: networkCommands.recent().map(commandView) }));
  app.get("/api/v1/network/commands/:id", requireOperator, (request, response) => {
    const record = networkCommands.get(String(request.params.id));
    return record ? response.json(commandView(record)) : response.status(404).json({ error: "no such order", code: "not_found" });
  });

  // The names, notes and "known" marks of the devices. Marking a device as known is a decision about security (it silences the alarm of a new device), so it is an administrator's.
  app.put("/api/v1/network/devices/:id", requireOperator, (request, response) => {
    const id = String(request.params.id);
    if (!DEVICE.test(id)) return response.status(400).json({ error: "invalid device id", code: "invalid_device" });
    // Naming a device, hiding it or asking to be told when it comes back is for a signed-in operator (not the service token); "known" is a decision about security.
    if (!studioUser(request)) return response.sendStatus(401);
    if ("trusted" in body(request) && studioUser(request)?.role !== "admin") return response.status(403).json({ error: "an administrator is required to mark a device as known", code: "forbidden" });
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

  // The login kept for the web administration of a device (an administrator's): the password goes in and never comes out.
  app.put("/api/v1/network/devices/:id/login", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    try {
      deviceCredentials.set(id, body(request));
      audit.record({ action: "network.device.login", outcome: "allowed", actor: actor(request), target: id, detail: "kept" });
      return response.json({ id, login: deviceCredentials.summary(id) });
    } catch (error) { return response.status(400).json({ error: error instanceof CredentialsInvalid ? error.message : "invalid login", code: "invalid_login" }); }
  });
  app.delete("/api/v1/network/devices/:id/login", requireAdmin, (request, response) => {
    const id = String(request.params.id);
    if (!DEVICE.test(id)) return response.status(400).json({ error: "invalid device id", code: "invalid_device" });
    const removed = deviceCredentials.remove(id);
    audit.record({ action: "network.device.login", outcome: removed ? "allowed" : "failed", actor: actor(request), target: id, detail: "forgotten" });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "no login is kept for that device", code: "not_found" });
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
  app.get("/api/v1/network/design/versions", requireOperator, (_request, response) => response.json({ versions: network.versions() }));
  app.get("/api/v1/network/design/versions/:id", requireOperator, (request, response) => {
    const doc = network.version(String(request.params.id));
    if (!doc) return response.status(404).json({ error: "no such version", code: "not_found" });
    return response.json({ revision: doc.revision, updated_at: doc.updated_at, updated_by: doc.updated_by, network: doc.site });
  });
  app.delete("/api/v1/network/design/versions", requireOperator, (request, response) => {
    const removed = network.deleteVersions();
    audit.record({ action: "network.versions.clear", outcome: "allowed", actor: actor(request), detail: `${removed} versions` });
    return response.json({ removed });
  });
  app.delete("/api/v1/network/design/versions/:id", requireOperator, (request, response) => {
    const removed = network.deleteVersion(String(request.params.id));
    audit.record({ action: "network.version.delete", outcome: removed ? "allowed" : "failed", actor: actor(request), target: String(request.params.id).slice(0, 60) });
    return removed ? response.sendStatus(204) : response.status(404).json({ error: "no such version", code: "not_found" });
  });
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
