/**
 * A.R.M.O.R. HTTP + WebSocket application, assembled from a configuration so a
 * test can build an isolated server on an ephemeral port.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { ArmorConfig } from "./config.js";
import { createContext, type AppContext, type ContextOverrides } from "./context.js";
import { hasBearer } from "./http/auth.js";
import { attachMqtt } from "./mqtt.js";
import { registerCameraRoutes } from "./routes/cameras.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerSessionRoutes } from "./routes/sessions.js";
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
  app.use(express.json({ limit: "64kb", type: "application/json" }));
  app.use(cors({ origin: config.studioOrigins, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
  // Field-node ingest has its own, larger budget (routes/ingest.ts): a burst of node messages must never lock an operator out.
  app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false, skip: request => request.method === "POST" && (request.path === "/api/v1/telemetry" || request.path === "/api/v1/health") }));

  registerIngestRoutes(app, context, Date.now(), version);
  registerSessionRoutes(app, context);
  registerHistoryRoutes(app, context);
  registerCameraRoutes(app, context);
  registerMediaRoutes(app, context);

  // Malformed JSON and other client errors get a plain answer, never a stack trace.
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    response.status(status >= 400 && status < 500 ? status : 500).json({ error: status >= 400 && status < 500 ? "invalid request" : "internal error" });
  });

  const server = createServer(app);
  // A browser cannot set headers on a WebSocket: an operator session cookie is enough as well as the control token.
  server.on("upgrade", (request, socket, head) => {
    const reader = headerReader(request);
    const allowed = request.url === "/api/v1/events" && (hasBearer(reader, config.controlToken) || context.operatorAuthorized(reader));
    if (!allowed) return socket.destroy();
    return clients.handleUpgrade(request, socket, head, client => clients.emit("connection", client, request));
  });

  const mqtt = config.mqtt ? attachMqtt(context.store, config.mqtt.url, config.mqtt.username, config.mqtt.password) : null;
  if (mqtt) context.notifier.setPublisher((topic, payload) => { if (mqtt.connected) mqtt.publish(topic, payload, { qos: 1 }); });
  // Silence and dwell time are time-driven: they need a clock, not a message.
  const sweeper = setInterval(() => context.store.sweep(), 2_000);
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
      for (const timer of watchdogs) clearTimeout(timer);
      context.store.flush();
      context.notifier.close();
      mqtt?.end(true);
      for (const client of clients.clients) client.terminate();
      clients.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
