/**
 * The shared context every route module receives: configuration, stores and
 * the two authorisation checks. Building it in one place keeps the routes small
 * and lets tests assemble an isolated server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { RequestHandler } from "express";
import { unixTransport, type AdminAgent } from "./admin.js";
import { FirmwareService } from "./firmware.js";
import { AiGateway } from "./ai.js";
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
import { ElectricalStore } from "./electrical.js";
import { SwitchingService } from "./electrical_switching.js";
import { DeviceNotes, NetworkStore } from "./network.js";
import { NetworkCommands } from "./network_commands.js";
import { DeviceCredentials } from "./device_credentials.js";
import { SystemMonitor } from "./system_metrics.js";
import { SolarRegistry } from "./solar_registry.js";
import { AlertNotifier } from "./notify.js";
import { homeAssistantChannel, telegramChannel, type NotifyChannel } from "./channels.js";
import { FileStatePersistence } from "./persistence.js";
import { RulesFile } from "./rules.js";
import { ArmorStore, type SystemState } from "./store.js";
import { PreferencesStore } from "./preferences.js";
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
  /** Language, theme and the saved weather place, kept per account rather than per browser or address. */
  preferences: PreferencesStore;
  devices: DeviceRegistry;
  alarms: AlarmCentre;
  alarmRules: AlarmRules;
  automations: AutomationEngine;
  site: SiteStore;
  electrical: SiteStore;
  /** What the ARMOR-ELECTRICAL nodes measure on the house's network. */
  electricalNodes: ElectricalStore;
  /** What the ARMOR-NETWORK nodes see on the local network, the names an operator gave the devices, and the network design drawn in Studio. */
  networkNodes: NetworkStore;
  networkNotes: DeviceNotes;
  /** The manual orders waiting for an ARMOR-NETWORK node and what it reported of them. */
  networkCommands: NetworkCommands;
  /** The logins kept for the web administration of the devices of the network, encrypted (see device_credentials.ts). */
  deviceCredentials: DeviceCredentials;
  /** How the machine is doing (processor, memory, temperatures, disks, network cards): sampled while the server runs, see system_metrics.ts. */
  systemMonitor: SystemMonitor;
  network: SiteStore;
  /** The one way a command reaches an electrical node's switch: off unless the operator turned it on (see electrical_switching.ts). */
  electricalSwitching: SwitchingService;
  /** Where its commands are published; set when the broker is connected (never retained, at most once). */
  switchLink: { publish?: (topic: string, payload: string) => void };
  /** The way to the admin agent, or null when there is none (see admin.ts). */
  admin: AdminAgent | null;
  /** Updating the firmware of field nodes from Studio (see firmware.ts). */
  firmware: FirmwareService;
  /** What the observation service may ask (see ai.ts). */
  ai: AiGateway;
  /** The token of the observation service, and only that (an operator session or token does not open the /api/v1/ai routes). */
  requireAi: RequestHandler;
  /** The solar inverters and batteries the gateway nodes report. */
  solar: SolarStore;
  /** The solar equipment an operator declared, kept in a file. */
  solarRegistry: SolarRegistry;
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

export type ContextOverrides = Partial<Pick<AppContext, "audit" | "admin" | "firmware" | "ai">> & { broadcast?: (state: SystemState) => void; now?: () => number };

export function createContext(config: ArmorConfig, overrides: ContextOverrides = {}): AppContext {
  const audit = overrides.audit ?? createAuditLog(config.dataDir);
  const warn = (message: string) => console.warn(message);
  // The name of a session cookie depends on whether the server speaks HTTPS: a browser that once met this server over HTTPS keeps its Secure cookie for the
  // host, and a page over plain HTTP is not allowed to replace a Secure cookie of the same name - the login seemed to work and then nothing stuck (found for real
  // after the HTTPS trial was undone). Different names for the two cases cannot shadow each other.
  const studioSessions = new SessionStore({ cookieName: config.cookieSecure ? "__Host-armor_studio_sid" : "armor_studio_sid", cookiePath: "/", ttlMs: config.studioSessionTtlMs, secure: config.cookieSecure, file: path.join(config.dataDir, "sessions.json") });
  const operatorSessions = new SessionStore({ cookieName: config.cookieSecure ? "__Secure-armor_operator_sid" : "armor_operator_sid", cookiePath: "/api/v1", ttlMs: config.operatorSessionTtlMs, secure: config.cookieSecure });
  if (config.cameraKeyIsFallback) warn("ARMOR_CAMERA_CONFIG_KEY is not set; using the migration fallback derived from ARMOR_CONTROL_TOKEN");
  const vault = new CameraVault({
    file: path.join(config.dataDir, "cameras.json"),
    secret: config.cameraConfigKey,
    // Earlier releases encrypted with the control token: migrate once when a dedicated key is introduced.
    legacySecret: config.cameraKeyIsFallback ? undefined : config.controlToken,
    warn,
  });
  const evidence = new EvidenceLibrary({ root: path.join(config.dataDir, "media"), ffmpegPath: config.ffmpegPath, maxBytes: config.maxMediaBytes, retentionMs: config.mediaRetentionMs, warn });
  const relays = new RelayManager({ ffmpegPath: config.ffmpegPath, maxRelays: config.maxMjpegRelays, fps: config.liveFps, width: config.liveWidth });
  const events = new EventLog({ file: path.join(config.dataDir, "events.log") });
  const rules = new RulesFile(path.join(config.dataDir, "rules.json"), config.alertDwellMs, warn);
  // The other places the alarms go. The address of Telegram can only be changed by the environment, for the tests that stand in for it.
  const channels: NotifyChannel[] = [];
  if (config.telegram) channels.push(telegramChannel({ token: config.telegram.token, chatIds: config.telegram.chatIds, api: process.env.ARMOR_TELEGRAM_API || undefined }));
  if (config.homeAssistant) channels.push(homeAssistantChannel({ url: config.homeAssistant.url, webhookId: config.homeAssistant.webhookId }));
  const notifier = new AlertNotifier({ webhookUrl: config.alertWebhookUrl ?? undefined, webhookSecret: config.alertWebhookSecret || undefined, audit, channels, language: config.alertLanguage });
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
  const electricalNodes = new ElectricalStore({ now: overrides.now, onMessage: message => alarmRules.handleElectrical(message), onStale: (node, stale) => alarmRules.handleElectricalStale(node, stale) });
  const electrical = new SiteStore(path.join(config.dataDir, "electrical.json"), () => new Date(), "electrical design");
  const networkNotes = new DeviceNotes(path.join(config.dataDir, "network-devices.json"));
  const systemMonitor = new SystemMonitor();
  const deviceCredentials = new DeviceCredentials({ file: path.join(config.dataDir, "network-logins.json"), secret: config.cameraConfigKey });
  const networkCommands = new NetworkCommands(overrides.now ? () => new Date(overrides.now!()) : undefined);
  // What a person needs to know about the device an alarm is about: the name they gave it (or the one it announces), where it is and who made it.
  const describeNetworkDevice = (node: string, id: string): Record<string, unknown> => {
    const device = networkNodes.device(node, id), note = networkNotes.get(id);
    return {
      device: note?.name ?? device?.hostname ?? device?.vendor ?? id, ip: device?.ip, mac: device?.mac ?? id, vendor: device?.vendor, hostname: device?.hostname,
      kind: note?.kind ?? device?.kind, os: device?.os, online: device?.online,
      open_ports: (device?.ports ?? []).slice(0, 16).map(port => `${port.port}/${port.proto}${port.service ? ` ${port.service}` : ""}`).join(", "),
    };
  };
  const networkNodes = new NetworkStore({
    now: overrides.now, notes: networkNotes, outagesFile: path.join(config.dataDir, "network-outages.json"),
    onMessage: message => alarmRules.handleNetwork(message),
    onEvent: (node, event) => {
      alarmRules.handleNetworkEvent(node, event, id => networkNotes.isTrusted(id), id => describeNetworkDevice(node, id));
      // A device somebody asked to be told about came onto the network: say so once.
      if (event.kind === "device_online" && event.device_id && networkNotes.isWatched(event.device_id)) {
        alarmRules.handleNetworkWatched(node, event, id => describeNetworkDevice(node, id));
        networkNotes.spendWatch(event.device_id);
      }
    },
    onStale: (node, stale) => alarmRules.handleNetworkStale(node, stale),
  });
  const network = new SiteStore(path.join(config.dataDir, "network.json"), () => new Date(), "network design");
  const switchLink: AppContext["switchLink"] = {};
  const electricalSwitching = new SwitchingService({
    enabled: config.electricalSwitching, nodes: electricalNodes, audit, now: overrides.now,
    publish: (topic, payload) => { if (!switchLink.publish) throw new Error("the MQTT broker is not connected"); switchLink.publish(topic, payload); },
  });
  const solarRegistry = new SolarRegistry(path.join(config.dataDir, "solar-devices.json"), overrides.now ? () => new Date(overrides.now!()) : undefined);
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
  const preferences = new PreferencesStore(path.join(config.dataDir, "preferences.json"));
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
  const requireAi: RequestHandler = (request, response, next) => {
    if (config.aiToken && hasBearer(request, config.aiToken)) return next();
    audit.record({ action: "ai.access", outcome: "denied", target: `${request.method} ${request.path}` });
    return response.status(401).json({ error: "the observation service token is required" });
  };
  return {
    ai: overrides.ai ?? new AiGateway({ ffmpegPath: config.ffmpegPath ?? "" }), requireAi,
    firmware: overrides.firmware ?? new FirmwareService({ nodePort: () => (process.env.ARMOR_ADMIN_NODE_PORT ? Number(process.env.ARMOR_ADMIN_NODE_PORT) : 0), releaseApi: () => process.env.ARMOR_FIRMWARE_RELEASE_API || "https://api.github.com" }),
    admin: overrides.admin ?? (config.admin ? { request: unixTransport(config.admin.socketPath, config.admin.token) } : null),
    config, store, events, rules, notifier, cameraWatcher, ptz: new PtzController(), audit, studioSessions, operatorSessions, users, preferences, studioUser, requireAdmin, devices, alarms, alarmRules, electrical, electricalNodes, electricalSwitching, switchLink, networkNodes, networkNotes, networkCommands, deviceCredentials, systemMonitor, network, automations, site, solar, solarRegistry, deviceLink, sendDeviceCommand, vault, evidence, relays,
    tickets: new StreamTickets(), discovery: new DiscoveryGate(), operatorAuthorized, requireOperator,
    publicCamera: camera => cameraPublic(camera, Boolean(config.ffmpegPath)),
    viewCamera: camera => cameraView(camera, Boolean(config.ffmpegPath)),
  };
}
