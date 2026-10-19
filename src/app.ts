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
import { createCoalescer } from "./ws_coalesce.js";
import type { ArmorConfig } from "./config.js";
import { createContext, type AppContext, type ContextOverrides } from "./context.js";
import { hasBearer } from "./http/auth.js";
import { attachMqtt, stampOf } from "./mqtt.js";
import { healthTopic, isNodeBirth, isNodeWill, parseNodeHealth } from "./node_health.js";
import { attachRoutes, type RouteTable } from "./mqtt_router.js";
import { registerAlarmRoutes } from "./routes/alarms.js";
import { registerCameraRoutes } from "./routes/cameras.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerSolarRoutes } from "./routes/solar.js";
import { registerElectricalRoutes } from "./routes/electrical.js";
import { registerBatteryOpsRoutes } from "./routes/battery_ops.js";
import { batteryTopic, parseBatteryResult } from "./battery_ops.js";
import { registerNetworkRoutes } from "./routes/network.js";
import { registerAlarmDesignRoutes } from "./routes/alarm_design.js";
import { registerAlarmProfileRoutes } from "./routes/alarm_profiles.js";
import { registerNodeHealthRoutes } from "./routes/node_health.js";
import { registerNodeControlRoutes } from "./routes/node_control.js";
import { controlTopic, parseControlResult, redactToken } from "./node_control.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { networkTopic, parseNetworkMessage } from "./network.js";
import { electricalTopic, parseElectricalMessage, parseElectricalResult } from "./electrical.js";
import { alarmTopic, parseAlarmMessage, parseAlarmResult } from "./alarm.js";
import { registerAlarmNodeRoutes } from "./routes/alarm.js";
import { registerPushRoutes } from "./routes/push.js";
import { parseSolarMessage, solarTopic } from "./solar.js";
import { DiscoveryPublisher } from "./ha_discovery.js";
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
  const sendState = (state: SystemState) => {
    const line = JSON.stringify({ type: "state", state });
    for (const client of clients.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) { client.terminate(); continue; }
      client.send(line);
    }
  };
  /** A burst of changes (several nodes reporting in the same moment) is one message with the newest state per window: the consoles only need the newest. */
  const WS_WINDOW_MS = 150;
  const stateFeed = createCoalescer<SystemState>(sendState, WS_WINDOW_MS);
  const broadcast = (state: SystemState) => stateFeed.push(state);
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
  // The API answers data, never a page: nothing it says may be kept by a cache or run by a browser (the panel of a node, passed on as it comes, sets its own headers).
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/") && !/^\/api\/v1\/nodes\/[^/]+\/panel(\/|$)/.test(request.path)) {
      response.set({ "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
    }
    if (config.tls) response.set("Strict-Transport-Security", "max-age=86400");
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
    skip: request => (request.method === "POST" && (request.path === "/api/v1/telemetry" || request.path === "/api/v1/health" || request.path === "/api/v1/solar" || request.path === "/api/v1/electrical/readings" || request.path === "/api/v1/network/state" || request.path === "/api/v1/alarm/state" || request.path === "/api/v1/node-health" || request.path === "/api/v1/devices/state")) || context.operatorAuthorized(request),
  }));

  // A signed-in console that keeps working keeps its session: the cookie is renewed once half of its life has gone.
  app.use((request, response, next) => { context.studioSessions.renew(request, response); context.operatorSessions.renew(request, response); next(); });
  // What a session from outside the house may do (ARMOR_REMOTE_POLICY): from "operate" on, administering (users, the installation, the firmware, the broker) is for the house or the VPN;
  // "view" lets it only look. The answer says what is needed, so the clients can explain it. Sessions made inside the house are not touched.
  app.use((request, response, next) => {
    if (config.remotePolicy === "full" || context.studioSessions.originOf(request) !== "remote") return next();
    const reads = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    const own = /^\/api\/v1\/(studio\/(session|sessions|elevate|totp)|push\/(un)?register)/.test(request.path) || (request.method === "POST" && /^\/api\/v1\/cameras\/[^/]+\/stream-ticket$/.test(request.path));
    const admin = /^\/api\/v1\/(admin|users|installation|system\/ingest|preferences|solar\/battery-ops|nodes\/control|nodes\/[^/]+\/(panel|control))(\/|$)/.test(request.path);
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
  registerBatteryOpsRoutes(app, context);
  registerAlarmNodeRoutes(app, context);
  registerPushRoutes(app, context);
  registerNetworkRoutes(app, context);
  registerAlarmDesignRoutes(app, context);
  registerAlarmProfileRoutes(app, context);
  registerNodeHealthRoutes(app, context);
  registerNodeControlRoutes(app, context);
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

  const mqtt = config.mqtt ? attachMqtt(context.store, config.mqtt.url, config.mqtt.username, config.mqtt.password, context.ingestLog, config.mqtt.ca?.pem) : null;
  /** A message of a node that was refused: said in the log and kept (with the start of what was sent) for Studio's System menu. */
  const rejected = (topic: string, raw: Buffer, error: unknown, fallback: string): void => {
    const why = error instanceof Error ? error.message : fallback;
    // The one-time token of a control order is never kept, not even in the sample of a message that was refused.
    const text = redactToken(topic, raw);
    context.ingestLog.rejected(topic, why, text);
    console.warn("ARMOR_MQTT=REJECTED", why);
  };
  if (mqtt) {
    // The link to the broker, in the history: one line when it is lost and one when it comes back (a broker that is down and retried every two seconds is not a line every two seconds).
    let brokerUp = false;
    mqtt.on("connect", () => { if (!brokerUp) { brokerUp = true; context.recordSystem({ category: "broker", action: "connected", subject: "mqtt" }); } });
    mqtt.on("close", () => { if (brokerUp) { brokerUp = false; context.recordSystem({ category: "broker", action: "disconnected", subject: "mqtt" }); } });
  }
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
    context.switchLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    context.alarmLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    context.controlLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    context.batteryLink.publish = (topic, payload) => { if (!mqtt.connected) throw new Error("the MQTT broker is not connected"); mqtt.publish(topic, payload, { qos: 0, retain: false }); };
    // What the server listens to besides the radar nodes (mqtt.ts), in one table (mqtt_router.ts). The broker lets a node write only its own topics, so a body that names another node
    // or device is refused. A command is never retained and is sent at most once: an old one must never be delivered later.
    const routes: RouteTable = [
      // The gateway nodes that read solar inverters and batteries: armor/solar/{node}/{device}/state.
      { subscribe: ["armor/solar/+/+/state"], named: solarTopic, parse: parseSolarMessage, fallback: "invalid solar payload", mismatch: "node_id and device do not match the topic",
        matches: (message: ReturnType<typeof parseSolarMessage>, named: [string, string]) => message.node_id === named[0] && message.device === named[1], apply: message => context.solar.ingest(message) },
      // The nodes that measure the house's electrical network: armor/electrical/{node}/state, and what a node answers to a command to its switch.
      { subscribe: ["armor/electrical/+/state"], named: (topic: string) => electricalTopic(topic), parse: parseElectricalMessage, fallback: "invalid electrical payload",
        matches: (message: ReturnType<typeof parseElectricalMessage>, named: string) => message.node_id === named, apply: message => context.electricalNodes.ingest(message) },
      { subscribe: ["armor/electrical/+/result"], named: (topic: string) => electricalTopic(topic, "result"), parse: parseElectricalResult, fallback: "invalid electrical result",
        matches: (message: ReturnType<typeof parseElectricalResult>, named: string) => message.node_id === named, apply: (message, named) => context.electricalSwitching.handleResult(message, named) },
      // What a gateway node answers to an order to write to a battery: armor/solar/{node}/maintenance/result.
      { subscribe: ["armor/solar/+/maintenance/result"], named: (topic: string) => batteryTopic(topic, "result"), parse: parseBatteryResult, fallback: "invalid battery result",
        matches: (message: ReturnType<typeof parseBatteryResult>, named: string) => message.node_id === named, apply: (message, named) => context.batteryWrite.handleResult(message, named) },
      // What a node answers to an order of remote control (restart, pause, standby ...): armor/control/{node}/result. The orders themselves are published only by this server (the broker's
      // access list allows no one else), and an answer of `all` is no answer.
      { subscribe: ["armor/control/+/result"], named: (topic: string) => controlTopic(topic, "result"), parse: parseControlResult, fallback: "invalid control result",
        matches: (message: ReturnType<typeof parseControlResult>, named: string) => message.node_id === named, apply: (message, named) => context.nodeControl.handleResult(message, named) },
      // The nodes that watch the local network: armor/network/{node}/state.
      { subscribe: ["armor/network/+/state"], named: networkTopic, parse: parseNetworkMessage, fallback: "invalid network payload",
        matches: (message: ReturnType<typeof parseNetworkMessage>, named: string) => message.node_id === named, apply: message => context.networkNodes.ingest(message) },
      // The alarm nodes: their state is armor/alarm/{node}/state and their answer to a command armor/alarm/{node}/result.
      { subscribe: ["armor/alarm/+/result"], named: (topic: string) => alarmTopic(topic, "result"), parse: parseAlarmResult, fallback: "invalid alarm result",
        matches: (message: ReturnType<typeof parseAlarmResult>, named: string) => message.node_id === named, apply: (message, named) => context.alarmCommands.handleResult(message, named) },
      { subscribe: ["armor/alarm/+/state"], named: (topic: string) => alarmTopic(topic), parse: parseAlarmMessage, fallback: "invalid alarm payload",
        matches: (message: ReturnType<typeof parseAlarmMessage>, named: string) => message.node_id === named, apply: message => context.alarmNodes.ingest(message) },
      // The health report of every family of node: armor/health/{node}. A report older than the one before is dropped, and a node without a clock is stamped on arrival. The same
      // topic carries the broker's last will for the node (the node was lost without saying goodbye) and the birth it says each time it connects, both retained: see isNodeWill and isNodeBirth in node_health.ts.
      { subscribe: ["armor/health/+"], named: healthTopic, parse: parseNodeHealth, fallback: "invalid node health payload",
        intercept: (body: unknown, named: string) => { if (isNodeWill(body, named)) { context.nodeLife.gone(named); context.nodeControl.handleOffline(named); return true; } if (isNodeBirth(body, named)) { context.nodeLife.report(named); return true; } return false; },
        matches: (message: ReturnType<typeof parseNodeHealth>, named: string) => message.node_id === named, apply: message => context.nodeHealth.ingest({ ...message, timestamp_ms: stampOf(message.timestamp_ms, Date.now()) }) },
    ];
    attachRoutes(mqtt, routes, context.ingestLog, rejected);
  }
  // The history of the readings outlives a restart: it is read back now and written once a minute and on the way out.
  const solarHistoryFile = new JsonFile<SolarHistoryFile>(path.join(config.dataDir, "solar-history.json"));
  const electricalHistoryFile = new JsonFile<ElectricalHistoryFile>(path.join(config.dataDir, "electrical-history.json"));
  context.solar.importHistory(solarHistoryFile.read());
  context.electricalNodes.importHistory(electricalHistoryFile.read());
  const electricalEnergyFile = new JsonFile<ReturnType<typeof context.electricalEnergy.export>>(path.join(config.dataDir, "electrical-energy.json"));
  context.electricalEnergy.import(electricalEnergyFile.read());
  // The last report of each node and its log of restarts outlive a restart of the server too.
  const nodeHealthFile = new JsonFile<ReturnType<typeof context.nodeHealth.export>>(path.join(config.dataDir, "node-health.json"));
  context.nodeHealth.import(nodeHealthFile.read());
  const saveHistory = (): void => {
    try { solarHistoryFile.write(context.solar.exportHistory()); electricalHistoryFile.write(context.electricalNodes.exportHistory()); electricalEnergyFile.write(context.electricalEnergy.export()); nodeHealthFile.write(context.nodeHealth.export()); }
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
      context.escalator.tick(); context.alarmZoneFeed.tick(); context.store.sweep(); context.devices.sweep(); context.solar.sweep(); context.electricalNodes.sweep(); context.electricalSwitching.sweep(); context.batteryWrite.sweep(); context.nodeControl.sweep(); context.alarmNodes.sweep(); context.alarmCommands.sweep(); context.reportSilentNodes(); context.networkNodes.sweep();
      context.studioSessions.sweep(); context.operatorSessions.sweep(); context.connections.registry.tick(); context.nodeLife.flush();
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
      stateFeed.close();
      context.systemMonitor.stop();
      saveHistory();
      for (const timer of watchdogs) clearTimeout(timer);
      context.store.flush(); context.knownNodes.flush();
      context.studioSessions.flush(); context.connections.registry.flush(); context.nodeLife.flush();
      clearTimeout(resume); context.devices.flush(); context.nodeControl.flush(); context.alarms.flush(); context.automations.close();
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
