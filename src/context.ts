/**
 * The shared context every route module receives: configuration, stores and
 * the two authorisation checks. Building it in one place keeps the routes small
 * and lets tests assemble an isolated server.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import type { RequestHandler } from "express";
import { unixTransport, type AdminAgent } from "./admin.js";
import { FirmwareService } from "./firmware.js";
import { AiGateway } from "./ai.js";
import { SecuritySettings } from "./security_settings.js";
import { createAuditLog, type AuditLog } from "./audit.js";
import { CameraVault } from "./cameras/vault.js";
import { DiscoveryGate } from "./cameras/discovery.js";
import { cameraPublic, cameraView, type CameraConnection } from "./cameras/model.js";
import type { ArmorConfig } from "./config.js";
import { hasBearer, SessionStore, type EndedSession, type HeaderSource } from "./http/auth.js";
import { UserStore, type PublicUser } from "./users.js";
import { classify, type Origin } from "./origin.js";
import { TotpStore } from "./totp.js";
import { EvidenceLibrary } from "./media/evidence.js";
import { RelayManager, StreamTickets } from "./media/relay.js";
import { CameraWatcher } from "./cameras/health.js";
import { Escalator } from "./escalation.js";
import { ElectricalEnergy } from "./electrical_energy.js";
import { PtzController } from "./cameras/ptz.js";
import { EventLog, type ArmorEventBody } from "./events.js";
import { AlarmCentre, AlarmRules } from "./alarms.js";
import { AutomationEngine, type Action } from "./automations.js";
import { DeviceRegistry, type DeviceChange } from "./devices/registry.js";
import { sendCommand, type Command } from "./devices/commands.js";
import { isTriggered } from "./devices/catalog.js";
import { AlarmZoneFeed, ZoneFeedSigner } from "./alarm_zone_feed.js";
import { CaptureOnDetect } from "./capture_on_detect.js";
import { IgnoreZones } from "./ignore_zones.js";
import { FcmDevices, fcmChannel, parseServiceAccount } from "./push_fcm.js";
import { GeoIpDatabase } from "./geoip.js";
import { LoginCountries } from "./login_places.js";
import { KnownNodes } from "./known_nodes.js";
import { SiteStore } from "./site.js";
import { SolarStore } from "./solar.js";
import { ElectricalStore } from "./electrical.js";
import { SwitchingService } from "./electrical_switching.js";
import { BatteryWriteService } from "./battery_write.js";
import { AlarmStore } from "./alarm.js";
import { ArmProfileStore } from "./arm_profiles.js";
import { ArmingModes } from "./arming_modes.js";
import { ModePanelSync } from "./mode_panel_sync.js";
import { NodeHealthStore } from "./node_health.js";
import { NodeControlService } from "./node_control_service.js";
import { AlarmCommands } from "./alarm_commands.js";
import { DeviceNotes, NetworkStore } from "./network.js";
import { NetworkCommands } from "./network_commands.js";
import { DeviceCredentials } from "./device_credentials.js";
import { SystemMonitor } from "./system_metrics.js";
import { SolarRegistry, batteryProfile } from "./solar_registry.js";
import { AlertNotifier } from "./notify.js";
import { homeAssistantChannel, ntfyChannel, telegramChannel, type NotifyChannel } from "./channels.js";
import { FileStatePersistence } from "./persistence.js";
import { RulesFile } from "./rules.js";
import { ArmorStore, type SystemState } from "./store.js";
import { PreferencesStore } from "./preferences.js";
import { IngestLog } from "./ingest_log.js";
import { DiagnosticTokens } from "./diagnostic_tokens.js";
import { NodeDiagnosticsStore } from "./node_diagnostics.js";
import { RadarEventStore, type RadarEvent } from "./radar_events.js";
import { EnergyAlarmStore } from "./energy_alarms.js";
import { ClientRegistry, ConnectionTracker, identify, NodeLife, systemBody, systemFromAudit, type Sighting, type SystemInput } from "./connections.js";
import path from "node:path";
import { SoundLibrary, SpokenCache } from "./alarm_audio.js";

export type AppContext = {
  config: ArmorConfig;
  /** The clients that connect (Studio, the phone, the panels of the nodes, the voice service...) and the connection events of the history. */
  connections: ConnectionTracker;
  /** Writes an event of the system (a node, the broker, a setting, a service...) in the history. */
  recordSystem: (input: SystemInput) => void;
  /** The sighting of the client that made this request, with the user when there is one. */
  sightingOf: (request: HeaderSource & { ip?: string }, user?: string) => Sighting;
  /** Which nodes are there, to tell when one appears or disappears. */
  nodeLife: NodeLife;
  store: ArmorStore;
  events: EventLog;
  rules: RulesFile;
  notifier: AlertNotifier;
  escalator: Escalator;
  cameraWatcher: CameraWatcher;
  ptz: PtzController;
  audit: AuditLog;
  studioSessions: SessionStore;
  operatorSessions: SessionStore;
  /** The second factor of the sign-in, and the proof of identity that critical actions ask for when the session came from outside the house. */
  totp: TotpStore;
  /** Where a request comes from, by the address the server sees (behind a proxy: the one ARMOR_TRUST_PROXY names). */
  originOfRequest: (request: { ip?: string }) => Origin;
  requireElevated: RequestHandler;
  users: UserStore;
  /** Language, theme and the saved weather place, kept per account rather than per browser or address. */
  preferences: PreferencesStore;
  devices: DeviceRegistry;
  alarms: AlarmCentre;
  alarmRules: AlarmRules;
  /** The levels at which batteries and inverters raise alarms (editable from Studio). */
  energyAlarms: EnergyAlarmStore;
  automations: AutomationEngine;
  site: SiteStore;
  electrical: SiteStore;
  /** What the ARMOR-NODE-ELECTRICAL nodes measure on the house's network. */
  electricalNodes: ElectricalStore;
  /** The energy of every electrical channel, day by day (a meter that wraps or is reset does not break the sum). */
  electricalEnergy: ElectricalEnergy;
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
  /** The alarm drawn in Studio's Alarm Designer (panels, sensors, sirens and how they are joined). */
  alarmDesign: SiteStore;
  /** The one way a command reaches an electrical node's switch: off unless the operator turned it on (see electrical_switching.ts). */
  electricalSwitching: SwitchingService;
  /** Where its commands are published; set when the broker is connected (never retained, at most once). */
  switchLink: { publish?: (topic: string, payload: string) => void };
  /** The one way an order to write to a Pylontech battery leaves this server: off unless the operator turned it on (see battery_write.ts). */
  batteryWrite: BatteryWriteService;
  /** Where its orders are published; set when the broker is connected (never retained, at most once). */
  batteryLink: { publish?: (topic: string, payload: string) => void };
  /** What the ARMOR-NODE-ALARM nodes say about the house's alarm. */
  alarmNodes: AlarmStore;
  /** The one way a command reaches an alarm node's panel: off unless the operator turned it on (see alarm_commands.ts). */
  alarmCommands: AlarmCommands;
  /** The named ways of arming a panel (Away, Home, Night, the owner's own), sent inside the arm command (see arm_profiles.ts). */
  armProfiles: ArmProfileStore;
  /** The arming modes (away, home, night) with their zones, delays and timetable; off unless the setting alarm.arming_modes is on (see arming_modes.ts). */
  armingModes: ArmingModes;
  /** Choosing a mode also arms the alarm panels with its profile; off unless the setting alarm.mode_panel_sync is on (see mode_panel_sync.ts). */
  modePanelSync: ModePanelSync;
  /** The latest health report of every node and what is wrong with it (see node_health.ts). */
  nodeHealth: NodeHealthStore;
  /** The read-only diagnostic tokens an administrator issues (see diagnostic_tokens.ts): only their hash is kept. */
  diagnosticTokens: DiagnosticTokens;
  /** The latest diagnostic package and log each node delivered when it was asked (see node_diagnostics.ts). */
  nodeDiagnostics: NodeDiagnosticsStore;
  /** The newest events of the perimeter engine of each radar node (see radar_events.ts). */
  radarEvents: RadarEventStore;
  /** The orders given to the nodes from Studio and the phone (restart, pause, standby, identify, diagnostics, maintenance) and what each node did (see node_control_service.ts). */
  nodeControl: NodeControlService;
  /** Where its orders are published; set when the broker is connected (never retained, at most once). */
  controlLink: { publish?: (topic: string, payload: string) => void };
  /** Where its commands are published; set when the broker is connected (never retained, at most once). */
  alarmLink: { publish?: (topic: string, payload: string) => void };
  /** Signs the zone messages and gives each panel its key. */
  zoneFeedSigner: ZoneFeedSigner;
  /** The security options an administrator turns on and off from Studio (see security_settings.ts). */
  securitySettings: SecuritySettings;
  /** The sounds an administrator uploaded for the origins of an alarm, and the spoken sentences already made. */
  alarmSounds: SoundLibrary;
  spokenAlarms: SpokenCache;
  /** The Zigbee sensors linked to the zones of the alarm panels, told to the panel while this server holds the radio. */
  alarmZoneFeed: AlarmZoneFeed;
  /** The photos and the video taken by themselves when a camera sees something while the perimeter is armed. */
  captureOnDetect: CaptureOnDetect;
  /** The parts of each camera's picture that the observation service does not look at. */
  ignoreZones: IgnoreZones;
  /** The Android phones that asked for push through Firebase; empty and unused unless ARMOR_FCM_SERVICE_ACCOUNT is set. */
  fcmDevices: FcmDevices;
  /** The country of an address, from the database the owner put on this machine (ARMOR_GEOIP_DB); null when there is none or it could not be read. */
  geoip: GeoIpDatabase | null;
  /** The countries each person has signed in from outside the house. */
  loginCountries: LoginCountries;
  /** The electrical nodes, alarm panels and network watchers that have ever spoken, and when: a restart does not make a node that is dead at that moment disappear. */
  knownNodes: KnownNodes;
  /** Reports as silent the known nodes that have said nothing since the server started (called now and then). */
  reportSilentNodes: () => void;
  /** Whether push through Firebase is on. */
  fcmEnabled: boolean;
  /** The way to the admin agent, or null when there is none (see admin.ts). */
  admin: AdminAgent | null;
  /** The maintenance agent: updates from GitHub, the system's updates and the root console (see routes/maintenance.ts). */
  maintenance: AdminAgent | null;
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
  /** What the broker and the ingest routes handed over: taken, refused and ignored fields per topic. */
  ingestLog: IngestLog;
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

export type ContextOverrides = Partial<Pick<AppContext, "audit" | "admin" | "maintenance" | "firmware" | "ai">> & { broadcast?: (state: SystemState) => void; now?: () => number };

export function createContext(config: ArmorConfig, overrides: ContextOverrides = {}): AppContext {
  const baseAudit = overrides.audit ?? createAuditLog(config.dataDir);
  // What the audit trail says is also told to the history, in its own vocabulary (see systemFromAudit): the audit entry is recorded first and a failure of the history never reaches the caller.
  const audit: AuditLog = { record(event) { baseAudit.record(event); try { const input = systemFromAudit(event); if (input) recordSystem(input); } catch { /* the history never breaks what it records */ } } };
  const ended: { tell?: (info: EndedSession, reason: "expired" | "logout" | "revoked") => void } = {};
  const warn = (message: string) => console.warn(message);
  // The name of a session cookie depends on whether the server speaks HTTPS: a browser that once met this server over HTTPS keeps its Secure cookie for the
  // host, and a page over plain HTTP is not allowed to replace a Secure cookie of the same name - the login seemed to work and then nothing stuck (found for real
  // after the HTTPS trial was undone). Different names for the two cases cannot shadow each other.
  const studioSessions = new SessionStore({ cookieName: config.cookieSecure ? "__Host-armor_studio_sid" : "armor_studio_sid", cookiePath: "/", ttlMs: config.studioSessionTtlMs, secure: config.cookieSecure, file: path.join(config.dataDir, "sessions.json"), remoteIdleMs: config.remoteIdleMs, onEnd: (info, reason) => ended.tell?.(info, reason) });
  const operatorSessions = new SessionStore({ cookieName: config.cookieSecure ? "__Secure-armor_operator_sid" : "armor_operator_sid", cookiePath: "/api/v1", ttlMs: config.operatorSessionTtlMs, secure: config.cookieSecure });
  if (config.cameraKeyIsFallback) warn("ARMOR_CAMERA_CONFIG_KEY is not set; using the migration fallback derived from ARMOR_CONTROL_TOKEN");
  const vault = new CameraVault({
    file: path.join(config.dataDir, "cameras.json"),
    secret: config.cameraConfigKey,
    // Earlier releases encrypted with the control token: migrate once when a dedicated key is introduced.
    legacySecret: config.cameraKeyIsFallback ? undefined : config.controlToken,
    warn,
  });
  const securityChanged: { tell?: (changes: Record<string, unknown>) => void } = {};
  const securitySettings = new SecuritySettings(path.join(config.dataDir, "security-settings.json"), {
    environment: () => ({ "alarm.disarm_pin": config.disarmPinEnv }),
    initial: { "voice.turn_max_bytes": config.voiceTurnMaxBytes, "voice.reply_audio_max_bytes": config.voiceReplyAudioMaxBytes },
    onChange: changes => securityChanged.tell?.(changes),
  });
  const alarmSounds = new SoundLibrary(path.join(config.dataDir, "alarm-sounds"));
  const spokenAlarms = new SpokenCache();
  const rtspProxy = () => securitySettings.get("media.rtsp_proxy");
  const evidence = new EvidenceLibrary({ root: path.join(config.dataDir, "media"), proxy: rtspProxy, ffmpegPath: config.ffmpegPath, maxBytes: config.maxMediaBytes, retentionMs: config.mediaRetentionMs, warn });
  const relays = new RelayManager({ proxy: rtspProxy, ffmpegPath: config.ffmpegPath, maxRelays: config.maxMjpegRelays, fps: config.liveFps, width: config.liveWidth, lowFps: config.liveLowFps, lowWidth: config.liveLowWidth });
  const events = new EventLog({ file: path.join(config.dataDir, "events.log") });
  const clients = new ClientRegistry({ file: path.join(config.dataDir, "connections.json"), now: overrides.now });
  const connections = new ConnectionTracker(clients, body => events.append(body));
  const recordSystem = (input: SystemInput): void => { events.append(systemBody(input)); };
  const nodeLife = new NodeLife(path.join(config.dataDir, "node-life.json"), recordSystem);
  const sightingOf = (request: HeaderSource & { ip?: string }, user?: string): Sighting => ({ ...identify(request), ...(request.ip ? { ip: request.ip } : {}), ...(user ? { user } : {}), origin: originOfRequest(request) });
  ended.tell = (info, reason) => {
    const user = info.userId ? users.get(info.userId)?.username : undefined;
    connections.ended({ ...identify({ header: name => (name.toLowerCase() === "user-agent" ? info.agent : undefined) }), ...(info.agent ? { agent: info.agent } : {}), ...(info.ip ? { ip: info.ip } : {}), ...(user ? { user } : {}), ...(info.origin ? { origin: info.origin } : {}) },
      reason === "expired" ? "session_expired" : reason === "logout" ? "logout" : "session_ended");
  };
  const knownNodes = new KnownNodes({ file: path.join(config.dataDir, "known-nodes.json"), now: overrides.now, warn });
  const rules = new RulesFile(path.join(config.dataDir, "rules.json"), config.alertDwellMs, warn);
  // The other places the alarms go. The address of Telegram can only be changed by the environment, for the tests that stand in for it.
  const channels: NotifyChannel[] = [];
  if (config.telegram) channels.push(telegramChannel({ token: config.telegram.token, chatIds: config.telegram.chatIds, api: process.env.ARMOR_TELEGRAM_API || undefined }));
  if (config.ntfy) channels.push(ntfyChannel({ url: config.ntfy.url, token: config.ntfy.token || undefined }));
  const fcmDevices = new FcmDevices(path.join(config.dataDir, "fcm-devices.json"));
  let geoip: GeoIpDatabase | null = null;
  if (config.geoipDb) {
    try { geoip = GeoIpDatabase.open(config.geoipDb); } catch (error) { warn(`The country database named by ARMOR_GEOIP_DB cannot be used (${error instanceof Error ? error.message : "unreadable"}); sign-ins are not told by country.`); }
  }
  const loginCountries = new LoginCountries(path.join(config.dataDir, "login-countries.json"));
  if (config.fcmServiceAccount) channels.push(fcmChannel({ account: parseServiceAccount(fs.readFileSync(config.fcmServiceAccount, "utf8")), devices: fcmDevices, dataOnly: config.fcmDataOnly }));
  if (config.homeAssistant) channels.push(homeAssistantChannel({ url: config.homeAssistant.url, webhookId: config.homeAssistant.webhookId }));
  const notifier = new AlertNotifier({ webhookUrl: config.alertWebhookUrl ?? undefined, webhookSecret: config.alertWebhookSecret || undefined, audit, channels, language: config.alertLanguage });
  const deviceLink: AppContext["deviceLink"] = {};
  const controlHolder: { service?: NodeControlService } = {};
  // Everything that happens goes through one place: written to the history, announced, checked for alarms, offered to the automations.
  const arming: { modes?: ArmingModes } = {};
  const record = (body: ArmorEventBody): void => {
    // A silent alarm (a duress disarm) is told to the places nobody at the panel can see and is NOT written in the history that every console reads.
    if (body.type === "alarm" && body.silent) { notifier.notify({ ...body, id: 0, at: new Date().toISOString() }, store.snapshot().mode); return; }
    const event = events.append(body);
    if (event.type === "node") { if (event.to === "online") nodeLife.report(event.node_id); else nodeLife.gone(event.node_id); }
    // A node that is being restarted on purpose, or is in maintenance, is not news to wake anybody for (it stays in the history).
    if (!(event.type === "node" && event.to !== "online" && controlHolder.service?.isHeld(event.node_id))) notifier.notify(event, store.snapshot().mode);
    if (event.type === "mode") arming.modes?.storeChanged(event.mode === "armed");
    alarmRules.handleEvent(event);
    if (event.type === "mode") automations.handleMode(event.mode);
  };
  const alarms = new AlarmCentre({ file: path.join(config.dataDir, "alarms.json"), onEvent: record, onRaised: alarm => automations.handleAlarm(alarm), warn });
  const energyAlarms = new EnergyAlarmStore(path.join(config.dataDir, "energy-alarms.json"));
  const alarmRules = new AlarmRules(alarms, () => store.snapshot().mode, () => energyAlarms.get());
  alarmRules.dnsDwellMs = config.networkDnsDwellMin * 60_000;
  const devices: DeviceRegistry = new DeviceRegistry({
    file: path.join(config.dataDir, "devices.json"), warn, onTopics: () => deviceLink.resubscribe?.(),
    onChange: (change: DeviceChange) => {
      if (change.onlineChanged) record({ type: "device", device_id: change.device.id, kind: change.device.kind, field: "online", from: !change.device.online, to: change.device.online });
      for (const item of change.changes) if (typeof item.to === "boolean") record({ type: "device", device_id: change.device.id, kind: change.device.kind, field: item.field, from: item.from, to: item.to });
      alarmRules.handleDevice(change);
      automations.handleDevice(change);
      alarmZoneFeed.handleDevice(change.device);
    },
  });
  const sendDeviceCommand = (id: string, command: Command) => sendCommand(devices, id, command, { publish: (topic, payload) => { if (!deviceLink.publish) throw new Error("the MQTT broker is not connected"); deviceLink.publish(topic, payload); } });
  const automations: AutomationEngine = new AutomationEngine({
    file: path.join(config.dataDir, "automations.json"), warn, mode: () => store.snapshot().mode,
    run: async (action: Action, automation) => {
      if (action.type === "device") {
        // An automation never switches a critical circuit: that is a person, an administrator, with a confirmation (see routes/devices.ts).
        if (devices.get(action.device_id)?.risk === "critical") throw new Error("an automation does not switch a critical circuit");
        await sendDeviceCommand(action.device_id, action.command);
        return;
      }
      notifier.send({ service: "armor-server", event: "automation.notify", at: new Date().toISOString(), mode: store.snapshot().mode, automation: automation.id });
    },
    onResult: (automation, action, ok, detail) => audit.record({ action: "automation.run", outcome: ok ? "allowed" : "failed", target: `${automation.id}:${action.type === "device" ? `${action.device_id}=${action.command}` : "notify"}`, detail }),
  });
  const site = new SiteStore(path.join(config.dataDir, "site.json"));
  const electricalEnergy = new ElectricalEnergy();
  const electricalNodes = new ElectricalStore({ now: overrides.now, setAsideOldReadings: () => securitySettings.get("electrical.set_aside_old_readings"), onMessage: message => { knownNodes.seen("electrical", message.node_id); alarmRules.handleElectrical(message); const at = (overrides.now ?? Date.now)(); for (const channel of message.channels) electricalEnergy.add(message.node_id, channel.id, channel.energy_kwh, at); }, onStale: (node, stale) => { alarmRules.handleElectricalStale(node, stale); if (stale) nodeLife.gone(node); else nodeLife.report(node); } });
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
    onMessage: message => { knownNodes.seen("network", message.node_id); alarmRules.handleNetwork(message); },
    onEvent: (node, event) => {
      alarmRules.handleNetworkEvent(node, event, id => networkNotes.isTrusted(id), id => describeNetworkDevice(node, id));
      // A device somebody asked to be told about came onto the network: say so once.
      if (event.kind === "device_online" && event.device_id && networkNotes.isWatched(event.device_id)) {
        alarmRules.handleNetworkWatched(node, event, id => describeNetworkDevice(node, id));
        networkNotes.spendWatch(event.device_id);
      }
    },
    onStale: (node, stale) => { alarmRules.handleNetworkStale(node, stale); if (stale) nodeLife.gone(node); else nodeLife.report(node); },
  });
  const network = new SiteStore(path.join(config.dataDir, "network.json"), () => new Date(), "network design");
  const alarmDesign = new SiteStore(path.join(config.dataDir, "alarm_design.json"), () => new Date(), "alarm design");
  const switchLink: AppContext["switchLink"] = {};
  const electricalSwitching = new SwitchingService({
    enabled: config.electricalSwitching, nodes: electricalNodes, audit, now: overrides.now,
    publish: (topic, payload) => { if (!switchLink.publish) throw new Error("the MQTT broker is not connected"); switchLink.publish(topic, payload); },
  });
  const alarmNodes = new AlarmStore({ now: overrides.now, onMessage: (message, previous) => { knownNodes.seen("alarm", message.node_id, message.phase); alarmRules.handleAlarmNode(message, previous); }, onStale: (node, stale, phase) => { alarmRules.handleAlarmNodeStale(node, stale, phase); if (stale) nodeLife.gone(node); else nodeLife.report(node); } });
  const alarmLink: AppContext["alarmLink"] = {};
  const armProfiles = new ArmProfileStore(path.join(config.dataDir, "arm-profiles.json"), overrides.now ? () => new Date(overrides.now!()) : undefined, warn);
  alarmRules.batteryProfileOf = id => { const registration = solarRegistry.list().find(item => `${item.node_id}/${item.device}` === id); return registration ? batteryProfile(registration.model) : undefined; };
  alarmRules.profileNotify = id => armProfiles.find(id)?.notify ?? (armProfiles.find(id) ? "urgent" : undefined);
  const diagnosticTokens = new DiagnosticTokens({ file: path.join(config.dataDir, "diagnostic_tokens.json"), now: overrides.now, audit });
  const nodeDiagnostics = new NodeDiagnosticsStore({ now: overrides.now });
  // What the History says of an event of a radar node: the sensors' Bluetooth and the events that matter to the guard of the house by name; the zones taken and left only stay in the node's list.
  const recordRadarEvent = (event: RadarEvent): void => {
    if (event.event === "zone_occupied" || event.event === "zone_clear") return;
    if (event.event === "sensor_bluetooth_open" || event.event === "sensor_bluetooth_closed") {
      recordSystem({ category: "node", action: event.event, subject: `${event.node_id}:${event.sensor_id}`, ...(event.name ? { profile: event.name } : {}) });
      return;
    }
    recordSystem({ category: "node", action: "radar_event", subject: event.node_id, profile: event.event });
  };
  const radarEvents = new RadarEventStore({ now: overrides.now, onNew: recordRadarEvent });
  const nodeHealth = new NodeHealthStore({
    now: overrides.now, onReport: view => { controlHolder.service?.handleReport(view.report); alarmRules.handleNodeHealth(view); nodeLife.report(view.node_id, view.firmware); },
    onForget: node => { alarmRules.forgetNodeHealth(node); nodeDiagnostics.forget(node); diagnosticTokens.forgetNode(node); radarEvents.remove(node); },
    onDirtyBoot: (node, _family, firmware, boot) => recordSystem({ category: "node", action: "dirty_boot", subject: node, profile: boot.cause, version: firmware }),
    remembered: node => controlHolder.service?.memoryOf(node),
  });
  const controlLink: AppContext["controlLink"] = {};
  // A node that is restarted on purpose or put in maintenance does not raise the alarms about its silence; when that ends and it is still silent they are raised after all.
  const recheckSilence = (node: string): void => {
    const view = nodeHealth.get(node);
    if (!view?.stale) return;
    if (view.family === "electrical") alarmRules.handleElectricalStale(node, true);
    else if (view.family === "alarm") alarmRules.handleAlarmNodeStale(node, true, alarmNodes.list().find(item => item.node_id === node)?.state.phase);
    else if (view.family === "solar") for (const item of solar.list()) { if (item.node_id === node) alarmRules.handleSolarStale(node, item.device, true); }
    else if (store.snapshot().nodes[node] || store.wallPanels().some(panel => panel.id === node)) alarmRules.handleEvent({ type: "node", node_id: node, from: "online", to: "offline" });
  };
  const nodeControl = new NodeControlService({
    publish: (topic, payload) => { if (!controlLink.publish) throw new Error("the MQTT broker is not connected"); controlLink.publish(topic, payload); },
    audit, history: recordSystem, health: node => nodeHealth.get(node), nodes: () => nodeHealth.list(), now: overrides.now, file: path.join(config.dataDir, "node_control.json"), maintenanceMaxS: config.nodeMaintenanceMaxS,
    onPackage: (node, delivered, requestedBy) => nodeDiagnostics.keep(node, delivered, requestedBy),
    onHold: (node, held) => { if (held) alarmRules.holdOffline(node); else recheckSilence(node); },
  });
  controlHolder.service = nodeControl;
  alarmRules.held = node => nodeControl.isHeld(node);
  const captureOnDetect = new CaptureOnDetect({ file: path.join(config.dataDir, "capture-on-detect.json"), audit, now: overrides.now, tools: { snapshot: camera => evidence.snapshot(camera), startRecording: camera => evidence.startRecording(camera), stopRecording: id => evidence.stopRecording(id), isRecording: id => evidence.isRecording(id) } });
  const ignoreZones = new IgnoreZones(path.join(config.dataDir, "camera-ignore-zones.json"));
  const zoneFeedSigner = new ZoneFeedSigner(path.join(config.dataDir, "zone-feed.key"));
  const alarmZoneFeed = new AlarmZoneFeed(path.join(config.dataDir, "alarm-zone-links.json"), { publish: (topic, payload) => { if (!alarmLink.publish) throw new Error("the MQTT broker is not connected"); alarmLink.publish(topic, payload); }, devices: () => devices.list(), now: overrides.now, warn,
    enabled: () => securitySettings.get("server.zone_feed"), signer: () => (securitySettings.get("server.zone_feed_signature") ? zoneFeedSigner : undefined),
    panels: () => alarmNodes.list().map(node => node.node_id),
    policy: () => ({ config_hash: securitySettings.get("alarm.config_hash"), zone_feed: securitySettings.get("server.zone_feed"), zone_feed_signature: securitySettings.get("server.zone_feed_signature"),
      // the environment wins over the setting, as it does for the people who disarm; "if_set" is not sent so that a panel from before the option keeps reading the message it knows
      ...(((): { disarm_pin?: "never" | "always" } => { const mode = config.disarmPinEnv ?? securitySettings.get("alarm.disarm_pin"); return mode === "if_set" ? {} : { disarm_pin: mode }; })()),
      ...(securitySettings.get("nodes.nvs_encryption") === "secrets" ? { nvs_encryption: "secrets" as const } : {}) }) });
  securityChanged.tell = () => { try { alarmZoneFeed.publishPolicy(); alarmZoneFeed.refresh(); } catch { /* the broker is not connected: the next sweep tells it */ } };
  const panelSyncLink: { settled?: (record: import("./alarm_commands.js").AlarmRecord) => void; view?: () => unknown } = {};
  const alarmCommands = new AlarmCommands({
    enabled: config.alarmCommands, nodes: alarmNodes, audit, now: overrides.now, onSettled: record => panelSyncLink.settled?.(record),
    publish: (topic, payload) => { if (!alarmLink.publish) throw new Error("the MQTT broker is not connected"); alarmLink.publish(topic, payload); },
  });
  const ingestLog = new IngestLog(overrides.now);
  const solarRegistry = new SolarRegistry(path.join(config.dataDir, "solar-devices.json"), overrides.now ? () => new Date(overrides.now!()) : undefined);
  const solar = new SolarStore({ now: overrides.now, onMessage: message => { knownNodes.seen("solar", `${message.node_id}/${message.device}`); alarmRules.handleSolar(message); }, onStale: (node, device, stale) => alarmRules.handleSolarStale(node, device, stale) });
  const batteryLink: AppContext["batteryLink"] = {};
  const batteryWrite = new BatteryWriteService({
    enabled: config.batteryWrite, solar, audit, now: overrides.now, file: path.join(config.dataDir, "battery_ops.json"),
    publish: (topic, payload) => { if (!batteryLink.publish) throw new Error("the MQTT broker is not connected"); batteryLink.publish(topic, payload); },
  });
  const persistence = new FileStatePersistence(path.join(config.dataDir, "state.json"), { warn });
  const store: ArmorStore = new ArmorStore(overrides.broadcast, {
    staleAfterMs: config.nodeStaleAfterS * 1000, now: overrides.now, persistence, rules: () => rules.get(), minTargets: config.alertMinTargets,
    guards: id => arming.modes?.guards("node", id) ?? true,
    armingMode: () => (arming.modes?.enabled ? arming.modes.current() : undefined),
    panelSync: () => panelSyncLink.view?.(),
    onEvent: record,
  });
  const escalator = new Escalator({ afterMin: config.escalateAfterMin, active: () => alarms.active(), send: message => notifier.send(message), mode: () => store.snapshot().mode, now: overrides.now });
  const cameraWatcher = new CameraWatcher({ list: () => vault.list(), onEvent: record, onAnswered: id => alarmRules.cameraAnswered(id) });
  // The nodes that were there before this run and have said nothing since: a node that is dead when the server comes up never goes stale, because it never existed in memory.
  const reportSilentNodes = (): void => {
    for (const node of knownNodes.silent(config.nodeStaleAfterS * 2000)) {
      if (node.kind === "electrical") alarmRules.handleElectricalStale(node.id, true);
      else if (node.kind === "alarm") alarmRules.handleAlarmNodeStale(node.id, true, node.phase);
      else if (node.kind === "solar") { const [gateway, device] = node.id.split("/"); if (gateway && device) alarmRules.handleSolarStale(gateway, device, true); }
      else alarmRules.handleNetworkStale(node.id, true);
    }
  };
  // Arming looks at what is already wrong (see AlarmRules.onArmed): the changes that would have raised it happened while it did not matter.
  alarmRules.onArmed = () => alarmRules.raisePresentProblems({
    nodesDown: Object.entries(store.snapshot().nodes).filter(([, node]) => !node.online || node.stale).map(([id]) => id),
    camerasDown: cameraWatcher.snapshot().filter(camera => camera.status === "offline").map(camera => camera.id),
    devicesTriggered: devices.list().filter(device => isTriggered(device.kind, device.state)).map(device => ({ id: device.id, kind: device.kind })),
  });
  const armingModes = new ArmingModes({
    file: path.join(config.dataDir, "arming-modes.json"), now: overrides.now, warn,
    enabled: () => securitySettings.get("alarm.arming_modes"), scheduleEnabled: () => securitySettings.get("alarm.mode_schedule"), scheduleMayLower: () => securitySettings.get("alarm.mode_schedule_lowers"),
    universe: () => [...devices.list().map(device => ({ type: "device" as const, id: device.id })), ...Object.keys(store.snapshot().nodes).map(id => ({ type: "node" as const, id })), ...vault.list().map(camera => ({ type: "camera" as const, id: camera.id }))],
    locationOf: unit => (unit.type === "device" ? devices.get(unit.id)?.location : undefined),
    isArmed: () => store.armed, setArmed: armed => { store.arm(armed ? "armed" : "disarmed"); },
    afterSwitch: () => { store.reevaluate(); alarmRules.modeSwitched(); }, afterExit: () => { store.reevaluate(); alarmRules.onArmed?.(); },
    afterApplied: (to, plan, by) => { if (to === "disarmed") modePanelSync.clear(); else modePanelSync.sync(to, by, plan.kind === "noop"); },
    report: what => audit.record({ action: "control.mode_schedule", outcome: what.applied ? "allowed" : "denied", actor: "schedule", detail: `${what.mode}${what.reason ? `: ${what.reason}` : ""}` }),
  });
  arming.modes = armingModes;
  const modePanelSync = new ModePanelSync({
    enabled: () => securitySettings.get("alarm.arming_modes") && securitySettings.get("alarm.mode_panel_sync"), now: overrides.now, audit, changed: () => { store.reevaluate(); },
    panels: () => alarmNodes.list().map(node => node.node_id), profile: id => armProfiles.find(id),
    arm: (node, base, actor, profile) => alarmCommands.request(node, "arm", base, false, actor, profile),
  });
  panelSyncLink.settled = record => modePanelSync.settled(record);
  panelSyncLink.view = () => modePanelSync.view();
  alarmRules.arming = { guards: (type, id) => armingModes.guards(type, id), entryDelayMs: (type, id) => armingModes.entryDelayMs(type, id), later: (key, ms, run) => armingModes.later(key, ms, run), cancelLater: () => armingModes.cancelLater() };
  alarmRules.deviceTriggered = id => { const device = devices.get(id); return device ? isTriggered(device.kind, device.state) : false; };
  const users = new UserStore({
    file: path.join(config.dataDir, "users.json"), seed: { username: config.studioUsername, password: config.studioPassword },
    minPasswordLength: config.passwordMinLength, resetSeedPassword: config.resetStudioPassword, warn,
  });
  const preferences = new PreferencesStore(path.join(config.dataDir, "preferences.json"));
  const studioUser = (request: HeaderSource): PublicUser | undefined => { const id = studioSessions.userId(request); return id ? users.get(id) : undefined; };
  // A wall panel's account is of the `panel` role: it is not an operator. It may only do what a wall panel does: read the summary, change the mode and acknowledge the alarms.
  const panelRoutes = new Set(["GET /api/v1/panel/summary", "POST /api/v1/mode", "POST /api/v1/alarms/acknowledge", "GET /api/v1/alarm-audio/spoken"]);
  // and the sound uploaded for an origin (one path per origin, so the list is closed)
  const panelSoundRoute = /^GET \/api\/v1\/alarm-audio\/sounds\/(device|solar|electrical|network|alarm|other)$/;
  const operatorAuthorized = (request: HeaderSource): boolean => {
    if (hasBearer(request, config.operatorToken) || operatorSessions.has(request)) return true;
    const user = studioUser(request);
    return Boolean(user) && user?.role !== "panel" && user?.role !== "viewer";
  };
  // A viewer (the family, a guard) only looks: every read, the stream tickets that let them watch a camera, and nothing that changes, deletes, switches, arms or configures. What holds secrets or
  // settings (the administration routes, the users, the console, the node tokens) is closed to them even to read.
  const viewerCloses = /^\/api\/v1\/(admin|users|system\/ingest|preferences|installation)(\/|$)/;
  const viewerMay = (method: string, path: string): boolean => (method === "GET" || method === "HEAD" ? !viewerCloses.test(path) : (method === "POST" && /^\/api\/v1\/cameras\/[^/]+\/(stream|preview)-ticket$/.test(path)) || ((method === "POST" || method === "DELETE") && (path === "/api/v1/push/register" || path === "/api/v1/push/unregister")));
  const requireOperator: RequestHandler = (request, response, next) => {
    // Whoever is let in (or turned away as a viewer or a wall panel) is a client the history knows about; a request that is not signed in is not, so strangers cannot fill the list.
    if (studioUser(request) || hasBearer(request, config.operatorToken) || operatorSessions.has(request)) { try { connections.seen(sightingOf(request, studioUser(request)?.username)); } catch { /* the list of clients never stops a request */ } }
    if (operatorAuthorized(request)) return next();
    const panel = studioUser(request);
    if (panel?.role === "viewer") {
      if (viewerMay(request.method, request.path)) return next();
      audit.record({ action: "viewer.access", outcome: "denied", actor: panel.username, target: `${request.method} ${request.path}` });
      return response.status(403).json({ error: "this account can only look" });
    }
    if (panel?.role === "panel") {
      if (panelRoutes.has(`${request.method} ${request.path}`) || panelSoundRoute.test(`${request.method} ${request.path}`)) return next();
      audit.record({ action: "panel.access", outcome: "denied", actor: panel.username, target: `${request.method} ${request.path}` });
      return response.status(403).json({ error: "this account only serves a wall panel" });
    }
    audit.record({ action: "operator.access", outcome: "denied", target: `${request.method} ${request.path}` });
    return response.status(401).json({ error: "operator authorization is required" });
  };
  const requireAdmin: RequestHandler = (request, response, next) => {
    if (studioUser(request)?.role === "admin") { try { connections.seen(sightingOf(request, studioUser(request)?.username)); } catch { /* see above */ } return next(); }
    audit.record({ action: "admin.access", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(studioUser(request) ? 403 : 401).json({ error: "an administrator is required" });
  };
  const totp = new TotpStore({ file: path.join(config.dataDir, "totp.json"), secret: config.cameraConfigKey });
  const originOfRequest = (request: { ip?: string }): Origin => classify(request.ip, config.localNetworks, config.vpnNetworks);
  // The critical actions (users, firmware, importing the installation) ask a session that came from outside the house for a new proof of identity, good for a few minutes
  // (POST /api/v1/studio/elevate). From inside the house nothing changes.
  const requireElevated: RequestHandler = (request, response, next) => {
    if (studioSessions.originOf(request) !== "remote" || studioSessions.elevated(request)) return next();
    audit.record({ action: "elevation.needed", outcome: "denied", actor: studioUser(request)?.username, target: `${request.method} ${request.path}` });
    return response.status(403).json({ error: "this needs the password or the code again", code: "elevation_required" });
  };
  const requireAi: RequestHandler = (request, response, next) => {
    if (config.aiToken && hasBearer(request, config.aiToken)) { try { connections.seen({ ...sightingOf(request), kind: "other", label: "observation-service" }); } catch { /* see above */ } return next(); }
    audit.record({ action: "ai.access", outcome: "denied", target: `${request.method} ${request.path}` });
    return response.status(401).json({ error: "the observation service token is required" });
  };
  return {
    ai: overrides.ai ?? new AiGateway({ ffmpegPath: config.ffmpegPath ?? "", proxy: rtspProxy }), requireAi,
    firmware: overrides.firmware ?? new FirmwareService({ nodePort: () => (process.env.ARMOR_ADMIN_NODE_PORT ? Number(process.env.ARMOR_ADMIN_NODE_PORT) : 0), releaseApi: () => process.env.ARMOR_FIRMWARE_RELEASE_API || "https://api.github.com" }),
    admin: overrides.admin ?? (config.admin ? { request: unixTransport(config.admin.socketPath, config.admin.token) } : null),
    maintenance: overrides.maintenance ?? (config.maintenance ? { request: unixTransport(config.maintenance.socketPath, config.maintenance.token, 70_000, "X-Armor-Maint-Token") } : null),
    connections, recordSystem, sightingOf, nodeLife, alarmDesign, alarmZoneFeed, zoneFeedSigner, securitySettings, geoip, loginCountries, alarmSounds, spokenAlarms, captureOnDetect, ignoreZones, fcmDevices, knownNodes, reportSilentNodes, nodeControl, controlLink, fcmEnabled: Boolean(config.fcmServiceAccount), config, store, events, rules, notifier, escalator, electricalEnergy, ingestLog, energyAlarms, cameraWatcher, ptz: new PtzController(), audit, studioSessions, operatorSessions, totp, originOfRequest, requireElevated, users, preferences, studioUser, requireAdmin, devices, alarms, alarmRules, electrical, electricalNodes, electricalSwitching, switchLink, batteryWrite, batteryLink, alarmNodes, alarmCommands, armProfiles, armingModes, modePanelSync, nodeHealth, diagnosticTokens, nodeDiagnostics, radarEvents, alarmLink, networkNodes, networkNotes, networkCommands, deviceCredentials, systemMonitor, network, automations, site, solar, solarRegistry, deviceLink, sendDeviceCommand, vault, evidence, relays,
    tickets: new StreamTickets(), discovery: new DiscoveryGate(), operatorAuthorized, requireOperator,
    publicCamera: camera => cameraPublic(camera, Boolean(config.ffmpegPath)),
    viewCamera: camera => cameraView(camera, Boolean(config.ffmpegPath)),
  };
}
