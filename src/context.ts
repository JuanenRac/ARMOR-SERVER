/**
 * The shared context every route module receives: configuration, stores and
 * the two authorisation checks. Building it in one place keeps the routes small
 * and lets tests assemble an isolated server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { RequestHandler } from "express";
import { createAuditLog, type AuditLog } from "./audit.js";
import { CameraVault } from "./cameras/vault.js";
import { DiscoveryGate } from "./cameras/discovery.js";
import { cameraPublic, cameraView, type CameraConnection } from "./cameras/model.js";
import type { ArmorConfig } from "./config.js";
import { hasBearer, SessionStore, type HeaderSource } from "./http/auth.js";
import { EvidenceLibrary } from "./media/evidence.js";
import { RelayManager, StreamTickets } from "./media/relay.js";
import { CameraWatcher } from "./cameras/health.js";
import { PtzController } from "./cameras/ptz.js";
import { EventLog } from "./events.js";
import { AlertNotifier } from "./notify.js";
import { FileStatePersistence } from "./persistence.js";
import { RulesFile } from "./rules.js";
import { ArmorStore, type SystemState } from "./store.js";
import path from "node:path";

export type AppContext = {
  config: ArmorConfig;
  store: ArmorStore;
  events: EventLog;
  rules: RulesFile;
  notifier: AlertNotifier;
  cameraWatcher: CameraWatcher;
  ptz: PtzController;
  audit: AuditLog;
  studioSessions: SessionStore;
  operatorSessions: SessionStore;
  vault: CameraVault;
  evidence: EvidenceLibrary;
  relays: RelayManager;
  tickets: StreamTickets;
  discovery: DiscoveryGate;
  operatorAuthorized(request: HeaderSource): boolean;
  requireOperator: RequestHandler;
  publicCamera(camera: CameraConnection): ReturnType<typeof cameraPublic>;
  viewCamera(camera: CameraConnection): ReturnType<typeof cameraView>;
};

export type ContextOverrides = Partial<Pick<AppContext, "audit">> & { broadcast?: (state: SystemState) => void; now?: () => number };

export function createContext(config: ArmorConfig, overrides: ContextOverrides = {}): AppContext {
  const audit = overrides.audit ?? createAuditLog(config.dataDir);
  const warn = (message: string) => console.warn(message);
  const studioSessions = new SessionStore({ cookieName: "armor_studio_session", cookiePath: "/", ttlMs: config.studioSessionTtlMs, secure: config.cookieSecure });
  const operatorSessions = new SessionStore({ cookieName: "armor_operator_session", cookiePath: "/api/v1", ttlMs: config.operatorSessionTtlMs, secure: config.cookieSecure });
  if (config.cameraKeyIsFallback) warn("ARMOR_CAMERA_CONFIG_KEY is not set; using the migration fallback derived from ARMOR_CONTROL_TOKEN");
  const vault = new CameraVault({
    file: path.join(config.dataDir, "cameras.json"),
    secret: config.cameraConfigKey,
    // Earlier releases encrypted with the control token: migrate once when a dedicated key is introduced.
    legacySecret: config.cameraKeyIsFallback ? undefined : config.controlToken,
    warn,
  });
  const evidence = new EvidenceLibrary({ root: path.join(config.dataDir, "media"), ffmpegPath: config.ffmpegPath, maxBytes: config.maxMediaBytes, retentionMs: config.mediaRetentionMs, warn });
  const relays = new RelayManager({ ffmpegPath: config.ffmpegPath, maxRelays: config.maxMjpegRelays });
  const events = new EventLog({ file: path.join(config.dataDir, "events.log") });
  const rules = new RulesFile(path.join(config.dataDir, "rules.json"), config.alertDwellMs, warn);
  const notifier = new AlertNotifier({ webhookUrl: config.alertWebhookUrl ?? undefined, webhookSecret: config.alertWebhookSecret || undefined, audit });
  const persistence = new FileStatePersistence(path.join(config.dataDir, "state.json"), { warn });
  const store: ArmorStore = new ArmorStore(overrides.broadcast, {
    staleAfterMs: config.nodeStaleAfterS * 1000, now: overrides.now, persistence, rules: () => rules.get(),
    onEvent: body => notifier.notify(events.append(body), store.snapshot().mode),
  });
  const cameraWatcher = new CameraWatcher({ list: () => vault.list(), onEvent: body => notifier.notify(events.append(body), store.snapshot().mode) });
  const operatorAuthorized = (request: HeaderSource): boolean =>
    hasBearer(request, config.operatorToken) || operatorSessions.has(request) || studioSessions.has(request);
  const requireOperator: RequestHandler = (request, response, next) => {
    if (operatorAuthorized(request)) return next();
    audit.record({ action: "operator.access", outcome: "denied", target: `${request.method} ${request.path}` });
    return response.status(401).json({ error: "operator authorization is required" });
  };
  return {
    config, store, events, rules, notifier, cameraWatcher, ptz: new PtzController(), audit, studioSessions, operatorSessions, vault, evidence, relays,
    tickets: new StreamTickets(), discovery: new DiscoveryGate(), operatorAuthorized, requireOperator,
    publicCamera: camera => cameraPublic(camera, Boolean(config.ffmpegPath)),
    viewCamera: camera => cameraView(camera, Boolean(config.ffmpegPath)),
  };
}
