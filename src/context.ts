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
import { UserStore, type PublicUser } from "./users.js";
import { EvidenceLibrary } from "./media/evidence.js";
import { RelayManager, StreamTickets } from "./media/relay.js";
import { CameraWatcher } from "./cameras/health.js";
import { PtzController } from "./cameras/ptz.js";
import { EventLog, type ArmorEventBody } from "./events.js";
import { AlarmCentre, AlarmRules } from "./alarms.js";
import { AutomationEngine, type Action } from "./automations.js";
import { DeviceRegistry, type DeviceChange } from "./devices/registry.js";
import { sendCommand, type Command } from "./devices/commands.js";
import { SiteStore } from "./site.js";
import { SolarStore } from "./solar.js";
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
  users: UserStore;
  devices: DeviceRegistry;
  alarms: AlarmCentre;
  alarmRules: AlarmRules;
  automations: AutomationEngine;
  site: SiteStore;
  /** The solar inverters and batteries the gateway nodes report. */
  solar: SolarStore;
  /** The MQTT side of devices: set once the broker client exists. */
  deviceLink: { publish?: (topic: string, payload: string) => void; resubscribe?: () => void };
  sendDeviceCommand(id: string, command: Command): ReturnType<typeof sendCommand>;
  /** The Studio user behind this request's session cookie, if any. */
  studioUser(request: HeaderSource): PublicUser | undefined;
  vault: CameraVault;
  evidence: EvidenceLibrary;
  relays: RelayManager;
  tickets: StreamTickets;
  discovery: DiscoveryGate;
  operatorAuthorized(request: HeaderSource): boolean;
  requireOperator: RequestHandler;
  /** A signed-in Studio user with the administrator role (bearer tokens are service credentials and do not qualify). */
  requireAdmin: RequestHandler;
  publicCamera(camera: CameraConnection): ReturnType<typeof cameraPublic>;
  viewCamera(camera: CameraConnection): ReturnType<typeof cameraView>;
};

export type ContextOverrides = Partial<Pick<AppContext, "audit">> & { broadcast?: (state: SystemState) => void; now?: () => number };

export function createContext(config: ArmorConfig, overrides: ContextOverrides = {}): AppContext {
  const audit = overrides.audit ?? createAuditLog(config.dataDir);
  const warn = (message: string) => console.warn(message);
  const studioSessions = new SessionStore({ cookieName: "armor_studio_session", cookiePath: "/", ttlMs: config.studioSessionTtlMs, secure: config.cookieSecure, file: path.join(config.dataDir, "sessions.json") });
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
  const deviceLink: AppContext["deviceLink"] = {};
  // Everything that happens goes through one place: written to the history, announced, checked for alarms, offered to the automations.
  const record = (body: ArmorEventBody): void => {
    const event = events.append(body);
    notifier.notify(event, store.snapshot().mode);
    alarmRules.handleEvent(event);
    if (event.type === "mode") automations.handleMode(event.mode);
  };
  const alarms = new AlarmCentre({ file: path.join(config.dataDir, "alarms.json"), onEvent: record, onRaised: alarm => automations.handleAlarm(alarm), warn });
  const alarmRules = new AlarmRules(alarms, () => store.snapshot().mode);
  const devices: DeviceRegistry = new DeviceRegistry({
    file: path.join(config.dataDir, "devices.json"), warn, onTopics: () => deviceLink.resubscribe?.(),
    onChange: (change: DeviceChange) => {
      if (change.onlineChanged) record({ type: "device", device_id: change.device.id, kind: change.device.kind, field: "online", from: !change.device.online, to: change.device.online });
      for (const item of change.changes) if (typeof item.to === "boolean") record({ type: "device", device_id: change.device.id, kind: change.device.kind, field: item.field, from: item.from, to: item.to });
      alarmRules.handleDevice(change);
      automations.handleDevice(change);
    },
  });
  const sendDeviceCommand = (id: string, command: Command) => sendCommand(devices, id, command, { publish: (topic, payload) => { if (!deviceLink.publish) throw new Error("the MQTT broker is not connected"); deviceLink.publish(topic, payload); } });
  const automations: AutomationEngine = new AutomationEngine({
    file: path.join(config.dataDir, "automations.json"), warn, mode: () => store.snapshot().mode,
    run: async (action: Action, automation) => {
      if (action.type === "device") { await sendDeviceCommand(action.device_id, action.command); return; }
      notifier.send({ service: "armor-server", event: "automation.notify", at: new Date().toISOString(), mode: store.snapshot().mode, automation: automation.id });
    },
    onResult: (automation, action, ok, detail) => audit.record({ action: "automation.run", outcome: ok ? "allowed" : "failed", target: `${automation.id}:${action.type === "device" ? `${action.device_id}=${action.command}` : "notify"}`, detail }),
  });
  const site = new SiteStore(path.join(config.dataDir, "site.json"));
  const solar = new SolarStore({ now: overrides.now, onMessage: message => alarmRules.handleSolar(message), onStale: (node, device, stale) => alarmRules.handleSolarStale(node, device, stale) });
  const persistence = new FileStatePersistence(path.join(config.dataDir, "state.json"), { warn });
  const store: ArmorStore = new ArmorStore(overrides.broadcast, {
    staleAfterMs: config.nodeStaleAfterS * 1000, now: overrides.now, persistence, rules: () => rules.get(),
    onEvent: record,
  });
  const cameraWatcher = new CameraWatcher({ list: () => vault.list(), onEvent: record });
  const users = new UserStore({
    file: path.join(config.dataDir, "users.json"), seed: { username: config.studioUsername, password: config.studioPassword },
    minPasswordLength: config.passwordMinLength, resetSeedPassword: config.resetStudioPassword, warn,
  });
  const studioUser = (request: HeaderSource): PublicUser | undefined => { const id = studioSessions.userId(request); return id ? users.get(id) : undefined; };
  const operatorAuthorized = (request: HeaderSource): boolean =>
    hasBearer(request, config.operatorToken) || operatorSessions.has(request) || Boolean(studioUser(request));
  const requireOperator: RequestHandler = (request, response, next) => {
    if (operatorAuthorized(request)) return next();
    audit.record({ action: "operator.access", outcome: "denied", target: `${request.method} ${request.path}` });
    return response.status(401).json({ error: "operator authorization is required" });
  };
  const requireAdmin: RequestHandler = (request, response, next) => {
    if (studioUser(request)?.role === "admin") return next();
    audit.record({ action: "admin.access", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(studioUser(request) ? 403 : 401).json({ error: "an administrator is required" });
  };
  return {
    config, store, events, rules, notifier, cameraWatcher, ptz: new PtzController(), audit, studioSessions, operatorSessions, users, studioUser, requireAdmin, devices, alarms, alarmRules, automations, site, solar, deviceLink, sendDeviceCommand, vault, evidence, relays,
    tickets: new StreamTickets(), discovery: new DiscoveryGate(), operatorAuthorized, requireOperator,
    publicCamera: camera => cameraPublic(camera, Boolean(config.ffmpegPath)),
    viewCamera: camera => cameraView(camera, Boolean(config.ffmpegPath)),
  };
}
