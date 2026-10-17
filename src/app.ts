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
import { registerAlarmDesignRoutes } from "./routes/alarm_design.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { networkTopic, parseNetworkMessage } from "./network.js";
import { electricalTopic, parseElectricalMessage, parseElectricalResult } from "./electrical.js";
import { alarmTopic, parseAlarmMessage, parseAlarmResult } from "./alarm.js";
import { registerAlarmNodeRoutes } from "./routes/alarm.js";
import { registerPushRoutes } from "./routes/push.js";
import { parseSolarMessage, solarTopic } from "./solar.js";
import { DiscoveryPublisher } from "./ha_discovery.js";
import { forwardCompatible } from "./contracts.js";
import { JsonFile } from "./history.js";
import type { ElectricalHistoryFile } from "./electrical.js";
import type { SolarHistoryFile } from "./solar.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerFirmwareRoutes } from "./routes/firmware.js";
import { registerNodePanelRoutes } from "./node_panel_proxy.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerUserRoutes } from "./routes/users.js";
import type { SystemState } from "./store.js";

export type ArmorApp = { server: Server; context: AppContext; close(): Promise<void> };

const headerReader = (request: IncomingMessage) => ({ header: (name: string) => { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } });

export function createArmorApp(config: ArmorConfig, version: string, overrides: ContextOverrides = {}): ArmorApp {
  // The server never reads what a client sends over the socket, so it accepts almost nothing of it (the default is 100 MiB, buffered).
  const clients = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  /** A client that is too far behind (its network is slow, or it stopped reading) is dropped rather than made to wait in memory: the next state it would get is only newer than the last. */
  const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
  const broadcast = (state: SystemState) => {
    const line = JSON.stringify({ type: "state", state });
    for (const client of clients.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) { client.terminate(); continue; }
      client.send(line);
    }
  };
  /** Who each open socket was admitted as. A session can end while the socket stays open (the user was removed, their role or password changed, the session expired). */
  const admitted = new WeakMap<object, { reader: ReturnType<typeof headerReader>; viaToken: boolean; alive: boolean }>();
  const context = createContext(config, { ...overrides, broadcast });
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy the client is whoever the proxy says in X-Forwarded-For - but only a proxy that was named (ARMOR_TRUST_PROXY) is believed.
  if (config.trustProxy !== false) app.set("trust proxy", config.trustProxy);
  app.use((_request, response, next) => {
    response.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-site" });
    next();
  });
  // The site design and the electrical design have their own, larger body limit (routes/alarms.ts); everything else is small.
  const smallJson = express.json({ limit: "64kb", type: "application/json" });
  // The panel of a node is passed on as it comes (its body goes to the node untouched), and the installation file has its own, larger limit (9 MB): neither is read here.
  app.use((request, response, next) => (/^\/api\/v1\/nodes\/[^/]+\/panel(\/|$)/.test(request.path) || (request.method === "POST" && request.path === "/api/v1/admin/installation") || ((request.path === "/api/v1/site" || request.path === "/api/v1/electrical/design" || request.path === "/api/v1/network/design" || request.path === "/api/v1/alarm/design") && request.method === "PUT") ? next() : smallJson(request, response, next)));
  app.use(cors({ origin: config.studioOrigins, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
  // Field-node ingest has its own, larger budget (routes/ingest.ts): a burst of node messages must never lock an operator out.
  // A signed-in operator is identified, so the console's own polling never spends the anonymous budget (which exists to slow a flood
  // from an unknown client); the sign-in route has its own, much tighter limit.
  app.use(rateLimit({
    windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false,
    skip: request => (request.method === "POST" && (request.path === "/api/v1/telemetry" || request.path === "/api/v1/health" || request.path === "/api/v1/solar" || request.path === "/api/v1/electrical/readings" || request.path === "/api/v1/network/state" || request.path === "/api/v1/alarm/state" || request.path === "/api/v1/devices/state")) || context.operatorAuthorized(request),
  }));

  // A signed-in console that keeps working keeps its session: the cookie is renewed once half of its life has gone.
  app.use((request, response, next) => { context.studioSessions.renew(request, response); context.operatorSessions.renew(request, response); next(); });
  // What a session from outside the house may do (ARMOR_REMOTE_POLICY): from "operate" on, administering (users, the installation, the firmware, the broker) is for the house or the VPN;
  // "view" lets it only look. The answer says what is needed, so the clients can explain it. Sessions made inside the house are not touched.
  app.use((request, response, next) => {
    if (config.remotePolicy === "full" || context.studioSessions.originOf(request) !== "remote") return next();
    const reads = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    const own = /^\/api\/v1\/(studio\/(session|sessions|elevate|totp)|push\/(un)?register)/.test(request.path) || (request.method === "POST" && /^\/api\/v1\/cameras\/[^/]+\/stream-ticket$/.test(request.path));
    const admin = /^\/api\/v1\/(admin|users|installation|system\/ingest|preferences|nodes\/[^/]+\/panel)(\/|$)/.test(request.path);
    if (reads && !(admin && config.remotePolicy === "view")) return next();
    if (own || (config.remotePolicy === "operate" && !admin)) return next();
    context.audit.record({ action: "remote.policy", outcome: "denied", actor: context.studioUser(request)?.username, target: `${request.method} ${request.path}`, detail: config.remotePolicy });
    return response.status(403).json({ error: "this is only possible from the house or over the VPN", code: "remote_policy", needs: "vpn" });
  });

  registerIngestRoutes(app, context, Date.now(), version);
  registerSessionRoutes(app, context);
  registerUserRoutes(app, context);
  registerPreferencesRoutes(app, context);
  registerDeviceRoutes(app, context);
  registerSolarRoutes(app, context);
  registerElectricalRoutes(app, context);
  registerAlarmNodeRoutes(app, context);
  registerPushRoutes(app, context);
  registerNetworkRoutes(app, context);
  registerAlarmDesignRoutes(app, context);
  registerMaintenanceRoutes(app, context);
  registerAlarmRoutes(app, context);
  registerSystemRoutes(app, context, version);
  registerAdminRoutes(app, context);
  registerFirmwareRoutes(app, context);
  registerNodePanelRoutes(app, context);
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
    // The path is compared without its query string (a client that adds one is the same client), and a page of another site cannot open the socket with the cookie of the operator: when
    // the request carries an Origin it must be this host's own or one of the configured Studio origins (a token, which a page cannot attach, needs no such check).
    const path = (request.url ?? "").split("?")[0];
    const origin = request.headers.origin;
    const originOk = !origin || (() => { try { return new URL(origin).host === request.headers.host; } catch { return false; } })() || config.studioOrigins.includes(origin);
    const allowed = path === "/api/v1/events" && (hasBearer(reader, config.controlToken) || (originOk && context.operatorAuthorized(reader)));
    if (!allowed) return socket.destroy();
    const viaToken = hasBearer(reader, config.controlToken);
    return clients.handleUpgrade(request, socket, head, client => {
      admitted.set(client, { reader, viaToken, alive: true });
      client.on("pong", () => { const entry = admitted.get(client); if (entry) entry.alive = true; });
      client.on("message", () => client.close(1003, "this socket only listens"));
      client.on("error", () => client.terminate());
      clients.emit("connection", client, request);
    });
  });
  // Every half minute: a socket that did not answer the last ping is gone, and one admitted by a session that no longer stands is closed (4401), so a user who was removed stops
  // seeing the live state with a tab that is still open.
  const watchSockets = setInterval(() => {
    for (const client of clients.clients) {
      const entry = admitted.get(client);
      if (!entry) continue;
      if (!entry.alive) { client.terminate(); continue; }
      if (!entry.viaToken && !context.operatorAuthorized(entry.reader)) { client.close(4401, "the session ended"); continue; }
      entry.alive = false;
      try { client.ping(); } catch { client.terminate(); }
    }
  }, 30_000);
  watchSockets.unref();

  const mqtt = config.mqtt ? attachMqtt(context.store, config.mqtt.url, config.mqtt.username, config.mqtt.password, context.ingestLog) : null;
  /** A message of a node that was refused: said in the log and kept (with the start of what was sent) for Studio's System menu. */
  const rejected = (topic: string, raw: Buffer, error: unknown, fallback: string): void => {
    const why = error instanceof Error ? error.message : fallback;
    context.ingestLog.rejected(topic, why, raw);
    console.warn("ARMOR_MQTT=REJECTED", why);
  };
  if (mqtt && config.haDiscovery) {
    // Home Assistant reads the same broker: it is told, once and then again now and then, what the nodes report (read-only sensors; ha_discovery.ts).
    const discovery = new DiscoveryPublisher({
      prefix: config.haDiscovery.prefix, solar: () => context.solar.list(), electrical: () => context.electricalNodes.list(), alarm: () => context.alarmNodes.list(),
      publish: (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 1, retain: true }); }, warn: message => console.warn(message),
    });
    // Every time the broker is (re)connected the rounds run again: they were stopped when it dropped, and a restart of the broker loses what was retained in memory.
    mqtt.on("connect", () => { discovery.forget(); discovery.round(true); discovery.start(); });
    discovery.start();
    mqtt.on("close", () => discovery.stop());
  }
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
  const electricalEnergyFile = new JsonFile<ReturnType<typeof context.electricalEnergy.export>>(path.join(config.dataDir, "electrical-energy.json"));
  context.electricalEnergy.import(electricalEnergyFile.read());
  const saveHistory = (): void => {
    try { solarHistoryFile.write(context.solar.exportHistory()); electricalHistoryFile.write(context.electricalNodes.exportHistory()); electricalEnergyFile.write(context.electricalEnergy.export()); }
    catch (error) { console.warn("ARMOR_HISTORY=NOT_SAVED", error instanceof Error ? error.message : "unknown error"); }
  };
  const historySaver = setInterval(saveHistory, 60_000);
  historySaver.unref();
  // Silence and dwell time are time-driven: they need a clock, not a message.
  // A failure of one pass must not take the process down (an uncaught exception in a timer would); it is said once, and again only after a pass that worked.
  // The "switch it back after N seconds" of an automation that were pending when the server stopped: done a few seconds after the start, once the broker had time to connect.
  const resume = setTimeout(() => context.automations.resumePending(), 5000);
  resume.unref();
  let sweepFailing = false;
  const sweeper = setInterval(() => {
    try {
      context.escalator.tick(); context.alarmZoneFeed.tick(); context.store.sweep(); context.devices.sweep(); context.solar.sweep(); context.electricalNodes.sweep(); context.electricalSwitching.sweep(); context.alarmNodes.sweep(); context.alarmCommands.sweep(); context.reportSilentNodes(); context.networkNodes.sweep();
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
      clearInterval(watchSockets);
      clearInterval(historySaver);
      saveHistory();
      for (const timer of watchdogs) clearTimeout(timer);
      context.store.flush(); context.knownNodes.flush();
      context.studioSessions.flush();
      clearTimeout(resume); context.devices.flush(); context.alarms.flush(); context.automations.close();
      await context.evidence.stopAll();   // a recording that is running is closed, not cut off
      context.notifier.close();
      context.ptz.close();
      mqtt?.end(true);
      for (const client of clients.clients) client.terminate();
      clients.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
