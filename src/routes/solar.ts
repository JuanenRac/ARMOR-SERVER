/**
 * Solar inverters and batteries: the messages the gateway nodes send over HTTP (over MQTT they arrive in app.ts), and what Studio and the phone read.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.js";
import { hasBearer } from "../http/auth.js";
import { forwardCompatible } from "../contracts.js";
import { parseSolarMessage } from "../solar.js";
import { ANT_CELL_COUNTS, ANT_CURRENTS, BATTERY_MODELS, CONNECTIONS, INVERTER_FAMILIES, INVERTER_MODELS, SolarRegistryError, exampleReading, modelLabel } from "../solar_registry.js";

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function registerSolarRoutes(app: Express, context: AppContext): void {
  const { config, solar, solarRegistry, requireOperator, audit, studioUser } = context;
  const actor = (request: Parameters<typeof studioUser>[0]): string => studioUser(request)?.username ?? "operator";
  const ingestLimit = rateLimit({ windowMs: 60_000, limit: 6_000, standardHeaders: "draft-8", legacyHeaders: false });

  app.post("/api/v1/solar", ingestLimit, (request, response) => {
    if (!hasBearer(request, config.ingestToken)) return response.sendStatus(401);
    try {
      const { value, ignored } = forwardCompatible(() => parseSolarMessage(request.body));
      solar.ingest(value);
      context.ingestLog.ok(`http:solar/${value.node_id}/${value.device}`, ignored);
      return response.status(202).json({ accepted: true, ...(ignored.length ? { ignored } : {}) });
    } catch (error) {
      const why = error instanceof Error ? error.message : "invalid solar message";
      context.ingestLog.rejected("http:solar", why, JSON.stringify(request.body ?? null));
      return response.status(400).json({ error: why });
    }
  });

  app.get("/api/v1/solar", requireOperator, (_request, response) => {
    const registered = new Map(solarRegistry.list().map(item => [`${item.node_id}/${item.device}`, item]));
    const devices = solar.list().map(view => ({ ...view, registered: registered.get(`${view.node_id}/${view.device}`) }));
    const reporting = new Set(devices.map(view => `${view.node_id}/${view.device}`));
    const waiting = solarRegistry.list().filter(item => !reporting.has(`${item.node_id}/${item.device}`));
    return response.json({ devices, waiting, totals: solar.totals(), catalog: {
      inverter_models: INVERTER_MODELS, battery_models: BATTERY_MODELS, connections: CONNECTIONS,
      labels: Object.fromEntries([...INVERTER_MODELS, ...BATTERY_MODELS].filter(model => model !== "other").map(model => [model, modelLabel(model)])),   // "other" is worded by each client, in its language
      inverter_dialects: Object.fromEntries(Object.entries(INVERTER_FAMILIES).map(([model, family]) => [model, family.dialect])),
      ant_bms: { cell_counts: ANT_CELL_COUNTS, currents_a: ANT_CURRENTS },
    } });
  });

  const fail = (response: Response, error: unknown) => {
    if (error instanceof SolarRegistryError) return response.status(error.status).json({ error: error.message });
    return response.status(500).json({ error: "internal error" });
  };

  // An operator declares the equipment (name, model, connection, gateway node); it shows as waiting until the node reports.
  app.post("/api/v1/solar/devices", requireOperator, (request, response) => {
    try {
      const { registration, created } = solarRegistry.save(typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {});
      audit.record({ action: created ? "solar.create" : "solar.update", outcome: "allowed", actor: actor(request), target: `${registration.node_id}/${registration.device}`, detail: registration.kind });
      return response.status(created ? 201 : 200).json(registration);
    } catch (error) { audit.record({ action: "solar.create", outcome: "failed", actor: actor(request) }); return fail(response, error); }
  });

  app.delete("/api/v1/solar/devices/:node/:device", requireOperator, (request, response) => {
    const node = String(request.params.node), device = String(request.params.device);
    if (!NODE.test(node) || !DEVICE.test(device)) return response.status(400).json({ error: "node and device are required" });
    const removed = solarRegistry.remove(node, device);
    solar.remove(node, device);
    if (!removed) return response.status(404).json({ error: "unknown solar device" });
    audit.record({ action: "solar.delete", outcome: "allowed", actor: actor(request), target: `${node}/${device}` });
    return response.sendStatus(204);
  });

  // One made-up reading of a declared device, so the menus can be tried before a gateway node reports; it is marked as an example.
  app.post("/api/v1/solar/devices/:node/:device/example", requireOperator, (request, response) => {
    const registration = solarRegistry.get(String(request.params.node), String(request.params.device));
    if (!registration) return response.status(404).json({ error: "declare the device first" });
    try {
      solar.ingest(exampleReading(registration, Date.now()), { example: true });
      audit.record({ action: "solar.example", outcome: "allowed", actor: actor(request), target: `${registration.node_id}/${registration.device}` });
      return response.status(202).json({ accepted: true, example: true });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "could not make the example" }); }
  });

  // What the panels made, the load used and the battery took and gave, day by day (the last `days`, at most a year), in kilowatt-hours.
  app.get("/api/v1/solar/energy", requireOperator, (request, response) => {
    const asked = Number(request.query.days ?? 30);
    const days = Number.isFinite(asked) ? Math.min(400, Math.max(1, Math.round(asked))) : 30;
    return response.json({ days: solar.energy(days) });
  });

  app.get("/api/v1/solar/history", requireOperator, (request, response) => {
    const node = typeof request.query.node === "string" ? request.query.node : "";
    const device = typeof request.query.device === "string" ? request.query.device : "";
    if (!NODE.test(node) || !DEVICE.test(device)) return response.status(400).json({ error: "node and device are required" });
    const asked = Number(request.query.minutes ?? 60);
    const minutes = Number.isFinite(asked) ? Math.min(43_200, Math.max(1, Math.round(asked))) : 60;
    const history = solar.history(node, device, minutes);
    if (!history) return response.status(404).json({ error: "unknown solar device" });
    return response.json({ node_id: node, device, kind: history.kind, minutes, samples: history.samples });
  });
}
