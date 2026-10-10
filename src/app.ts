/**
 * A.R.M.O.R. HTTP + WebSocket application, assembled from a configuration so a
 * test can build an isolated server on an ephemeral port.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import path from "node:path";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer } from "ws";
import type { ArmorConfig } from "./config.js";
import { createContext, type AppContext, type ContextOverrides } from "./context.js";
import { hasBearer } from "./http/auth.js";
import { attachMqtt } from "./mqtt.js";
import { registerAlarmRoutes } from "./routes/alarms.js";
import { registerCameraRoutes } from "./routes/cameras.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerSolarRoutes } from "./routes/solar.js";
import { registerElectricalRoutes } from "./routes/electrical.js";
import { registerNetworkRoutes } from "./routes/network.js";
import { networkTopic, parseNetworkMessage } from "./network.js";
import { electricalTopic, parseElectricalMessage, parseElectricalResult } from "./electrical.js";
import { alarmTopic, parseAlarmMessage, parseAlarmResult } from "./alarm.js";
import { registerAlarmNodeRoutes } from "./routes/alarm.js";
import { parseSolarMessage, solarTopic } from "./solar.js";
import { forwardCompatible } from "./contracts.js";
import { JsonFile } from "./history.js";
import type { ElectricalHistoryFile } from "./electrical.js";
import type { SolarHistoryFile } from "./solar.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerFirmwareRoutes } from "./routes/firmware.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerUserRoutes } from "./routes/users.js";
import type { SystemState } from "./store.js";

export type ArmorApp = { server: Server; context: AppContext; close(): Promise<void> };

const headerReader = (request: IncomingMessage) => ({ header: (name: string) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } });

export function createArmorApp(config: ArmorConfig, version: string, overrides: ContextOverrides = {}): ArmorApp {
  const clients = new WebSocketServer({ noServer: true });
  const broadcast = (state: SystemState) => {
    const line = JSON.stringify({ type: "state", state });
    for (const client of clients.clients) if (client.readyState === client.OPEN) client.send(line);
  };
  const context = createContext(config, { ...overrides, broadcast });
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-site" });
    next();
  });
  // The site design and the electrical design have their own, larger body limit (routes/alarms.ts); everything else is small.
  const smallJson = express.json({ limit: "64kb", type: "application/json" });
  app.use((request, response, next) => ((request.path === "/api/v1/site" || request.path === "/api/v1/electrical/design" || request.path === "/api/v1/network/design") && request.method === "PUT" ? next() : smallJson(request, response, next)));
  app.use(cors({ origin: config.studioOrigins, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
  // Field-node ingest has its own, larger budget (routes/ingest.ts): a burst of node messages must never lock an operator out.
  // A signed-in operator is identified, so the console's own polling never spends the anonymous budget (which exists to slow a flood
  // from an unknown client); the sign-in route has its own, much tighter limit.
  app.use(rateLimit({
    windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false,
    skip: request => (request.method === "POST" && (request.path === "/api/v1/telemetry" || request.path === "/api/v1/health" || request.path === "/api/v1/solar" || request.path === "/api/v1/electrical/readings" || request.path === "/api/v1/network/state")) || context.operatorAuthorized(request),
  }));

  // A signed-in console that keeps working keeps its session: the cookie is renewed once half of its life has gone.
  app.use((request, response, next) => { context.studioSessions.renew(request, response); context.operatorSessions.renew(request, response); next(); });

  registerIngestRoutes(app, context, Date.now(), version);
  registerSessionRoutes(app, context);
  registerUserRoutes(app, context);
  registerPreferencesRoutes(app, context);
  registerDeviceRoutes(app, context);
  registerSolarRoutes(app, context);
  registerElectricalRoutes(app, context);
  registerAlarmNodeRoutes(app, context);
  registerNetworkRoutes(app, context);
  registerAlarmRoutes(app, context);
  registerSystemRoutes(app, context, version);
  registerAdminRoutes(app, context);
  registerFirmwareRoutes(app, context);
  registerVoiceRoutes(app, context);
  registerAiRoutes(app, context);
  registerNotificationRoutes(app, context);
  registerHistoryRoutes(app, context);
  registerCameraRoutes(app, context);
  registerMediaRoutes(app, context);

  // Malformed JSON and other client errors get a plain answer, never a stack trace.
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    response.status(status >= 400 && status < 500 ? status : 500).json({ error: status >= 400 && status < 500 ? "invalid request" : "internal error" });
  });

  // config.tls is only ever set when readConfig() already found both
  // TLS_CERT_PATH and TLS_KEY_PATH pointing at an existing file - a real,
  // specific fs error (permissions, an expired/malformed PEM) still fails
  // start-up loudly right here rather than silently falling back to plain
  // HTTP. The WebSocket 'upgrade' handling below is unchanged either way:
  // an https.Server emits the same 'upgrade' event a plain http.Server
  // does, so /api/v1/events becomes WSS the moment this does, with no
  // separate configuration.
  const server: Server = config.tls
    ? (createHttpsServer({ cert: fs.readFileSync(config.tls.certPath), key: fs.readFileSync(config.tls.keyPath) }, app) as unknown as Server)
    : createServer(app);
  // A browser cannot set headers on a WebSocket: an operator session cookie is enough as well as the control token.
  server.on("upgrade", (request, socket, head) => {
    const reader = headerReader(request);
    const allowed = request.url === "/api/v1/events" && (hasBearer(reader, config.controlToken) || context.operatorAuthorized(reader));
    if (!allowed) return socket.destroy();
    return clients.handleUpgrade(request, socket, head, client => clients.emit("connection", client, request));
  });

  const mqtt = config.mqtt ? attachMqtt(context.store, config.mqtt.url, config.mqtt.username, config.mqtt.password, context.ingestLog) : null;
  /** A message of a node that was refused: said in the log and kept (with the start of what was sent) for Studio's System menu. */
  const rejected = (topic: string, raw: Buffer, error: unknown, fallback: string): void => {
    const why = error instanceof Error ? error.message : fallback;
    context.ingestLog.rejected(topic, why, raw);
    console.warn("ARMOR_MQTT=REJECTED", why);
  };
  if (mqtt) context.notifier.setPublisher((topic, payload) => { if (mqtt.connected) mqtt.publish(topic, payload, { qos: 1 }); });
  if (mqtt) {
    // Devices speak over the same broker: subscribe to their topics (again whenever the list changes), hand their messages to the registry, and publish commands.
    context.deviceLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 1 }); };
    context.deviceLink.resubscribe = () => { const topics = context.devices.topics(); if (topics.length > 0 && mqtt.connected) mqtt.subscribe(topics, { qos: 1 }); };
    mqtt.on("connect", () => context.deviceLink.resubscribe?.());
    mqtt.on("message", (topic, raw) => { try { context.devices.ingestMqtt(topic, raw); } catch { /* one bad device message never stops the rest */ } });
    // The gateway nodes that read solar inverters and batteries: armor/solar/{node}/{device}/state. The broker lets a node write only its own topics, so a body that
    // names another node or device is refused, as for the radar nodes.
    mqtt.on("connect", () => mqtt.subscribe("armor/solar/+/+/state", { qos: 1 }));
    // The nodes that measure the house's electrical network: armor/electrical/{node}/state, the same rule for the node named in the body.
    mqtt.on("connect", () => mqtt.subscribe("armor/electrical/+/state", { qos: 1 }));
    // The nodes that watch the local network: armor/network/{node}/state, the same rule for the node named in the body.
    mqtt.on("connect", () => mqtt.subscribe("armor/network/+/state", { qos: 1 }));
    mqtt.on("message", (topic, raw) => {
      const named = networkTopic(topic);
      if (!named) return;
      try {
        const { value: message, ignored } = forwardCompatible(() => parseNetworkMessage(JSON.parse(raw.toString("utf8"))));
        if (message.node_id !== named) throw new Error("node_id does not match the topic");
        context.networkNodes.ingest(message);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid network payload"); }
    });
    // What a node answers to a command to its switch. A command is never retained and is sent at most once: an old one must never be delivered later, and a node that
    // was away misses it (the node's own arm and token make a late one harmless anyway).
    mqtt.on("connect", () => mqtt.subscribe("armor/electrical/+/result", { qos: 1 }));
    context.switchLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    mqtt.on("message", (topic, raw) => {
      const named = electricalTopic(topic, "result");
      if (!named) return;
      try {
        const { value: result, ignored } = forwardCompatible(() => parseElectricalResult(JSON.parse(raw.toString("utf8"))));
        if (result.node_id !== named) throw new Error("node_id does not match the topic");
        context.electricalSwitching.handleResult(result, named);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid electrical result"); }
    });
    // The alarm nodes: their state is armor/alarm/{node}/state and their answer to a command armor/alarm/{node}/result, the same rule for the node named in the body. A command is
    // never retained and is sent at most once: an old one must never be delivered later.
    mqtt.on("connect", () => mqtt.subscribe(["armor/alarm/+/state", "armor/alarm/+/result"], { qos: 1 }));
    context.alarmLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    mqtt.on("message", (topic, raw) => {
      const named = alarmTopic(topic, "result");
      if (!named) return;
      try {
        const { value: result, ignored } = forwardCompatible(() => parseAlarmResult(JSON.parse(raw.toString("utf8"))));
        if (result.node_id !== named) throw new Error("node_id does not match the topic");
        context.alarmCommands.handleResult(result, named);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid alarm result"); }
    });
    mqtt.on("message", (topic, raw) => {
      const named = alarmTopic(topic);
      if (!named) return;
      try {
        const { value: message, ignored } = forwardCompatible(() => parseAlarmMessage(JSON.parse(raw.toString("utf8"))));
        if (message.node_id !== named) throw new Error("node_id does not match the topic");
        context.alarmNodes.ingest(message);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid alarm payload"); }
    });
    mqtt.on("message", (topic, raw) => {
      const named = electricalTopic(topic);
      if (!named) return;
      try {
        const { value: message, ignored } = forwardCompatible(() => parseElectricalMessage(JSON.parse(raw.toString("utf8"))));
        if (message.node_id !== named) throw new Error("node_id does not match the topic");
        context.electricalNodes.ingest(message);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid electrical payload"); }
    });
    mqtt.on("message", (topic, raw) => {
      const named = solarTopic(topic);
      if (!named) return;
      try {
        const { value: message, ignored } = forwardCompatible(() => parseSolarMessage(JSON.parse(raw.toString("utf8"))));
        if (message.node_id !== named[0] || message.device !== named[1]) throw new Error("node_id and device do not match the topic");
        context.solar.ingest(message);
        context.ingestLog.ok(topic, ignored);
      } catch (error) { rejected(topic, raw, error, "invalid solar payload"); }
    });
  }
  // The history of the readings outlives a restart: it is read back now and written once a minute and on the way out.
  const solarHistoryFile = new JsonFile<SolarHistoryFile>(path.join(config.dataDir, "solar-history.json"));
  const electricalHistoryFile = new JsonFile<ElectricalHistoryFile>(path.join(config.dataDir, "electrical-history.json"));
  context.solar.importHistory(solarHistoryFile.read());
  context.electricalNodes.importHistory(electricalHistoryFile.read());
  const saveHistory = (): void => {
    try { solarHistoryFile.write(context.solar.exportHistory()); electricalHistoryFile.write(context.electricalNodes.exportHistory()); }
    catch (error) { console.warn("ARMOR_HISTORY=NOT_SAVED", error instanceof Error ? error.message : "unknown error"); }
  };
  const historySaver = setInterval(saveHistory, 60_000);
  historySaver.unref();
  // Silence and dwell time are time-driven: they need a clock, not a message.
  // A failure of one pass must not take the process down (an uncaught exception in a timer would); it is said once, and again only after a pass that worked.
  let sweepFailing = false;
  const sweeper = setInterval(() => {
    try {
      context.store.sweep(); context.devices.sweep(); context.solar.sweep(); context.electricalNodes.sweep(); context.electricalSwitching.sweep(); context.alarmNodes.sweep(); context.alarmCommands.sweep(); context.networkNodes.sweep();
      sweepFailing = false;
    } catch (error) {
      if (!sweepFailing) console.warn("ARMOR_SWEEP=FAILED", error instanceof Error ? error.message : "unknown error");
      sweepFailing = true;
    }
  }, 2_000);
  sweeper.unref();
  // The camera watchdog: a first pass shortly after start, then on a fixed interval.
  const watchdogs: NodeJS.Timeout[] = [];
  if (config.cameraCheckS > 0) {
    const first = setTimeout(() => void context.cameraWatcher.check(), 3_000);
    const every = setInterval(() => void context.cameraWatcher.check(), config.cameraCheckS * 1000);
    first.unref(); every.unref(); watchdogs.push(first, every);
  }
  return {
    server, context,
    close: async () => {
      clearInterval(sweeper);
      clearInterval(historySaver);
      saveHistory();
      for (const timer of watchdogs) clearTimeout(timer);
      context.store.flush();
      context.studioSessions.flush();
      context.devices.flush(); context.alarms.flush(); context.automations.close();
      context.notifier.close();
      context.ptz.close();
      mqtt?.end(true);
      for (const client of clients.clients) client.terminate();
      clients.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
