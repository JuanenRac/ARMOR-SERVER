/**
 * A.R.M.O.R. server configuration: one place that reads the environment, checks
 * every value and refuses to start on a weak or inconsistent one.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { ALERT_LANGUAGES, isAlertLanguage, type AlertLanguage } from "./alert_text.js";
import { validTelegramChat, validTelegramToken, validWebhookId } from "./channels.js";
import fs from "node:fs";
import { ARMOR_PORTS } from "./armor-ports.js";
import path from "node:path";
import { originsWithStudioPort, readConnection } from "./connection.js";
import { isTlsUrl, readCaFile, type MqttCa } from "./mqtt_tls.js";
import { DEFAULT_LOCAL_NETWORKS, parseRanges } from "./origin.js";
import { DEFAULT_SENSOR_FIELDS } from "./daily_log.js";
import { parseVisionServiceUrl } from "./security_settings.js";
import { parseHeartbeatUrl } from "./heartbeat.js";

export const MIN_SECRET_LENGTH = 24;

export type ArmorConfig = {
  host: string;
  port: number;
  ingestToken: string;
  /** The shared ingest token is no longer accepted from nodes: each one must hold its own (see http/node_token.ts). */
  ingestStrict: boolean;
  controlToken: string;
  operatorToken: string;
  cameraConfigKey: string;
  /** True when the camera key fell back to the control token (migration only). */
  cameraKeyIsFallback: boolean;
  studioUsername: string;
  studioPassword: string;
  /** Shortest password accepted for a Studio user: 12 characters on a reachable server, 8 on a loopback-only one. */
  passwordMinLength: number;
  /** Reset the seed administrator's password from ARMOR_STUDIO_PASSWORD at start-up (recovery of a forgotten password). */
  resetStudioPassword: boolean;
  studioSessionTtlMs: number;
  operatorSessionTtlMs: number;
  /** ARMOR_VOICE_TURN_MAX_BYTES: the most audio one spoken turn of the wall panel may carry (raw or in the binary form); 480000 bytes is 15 seconds of 16 kHz 16-bit mono. */
  voiceTurnMaxBytes: number;
  /** ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES: the most spoken answer handed on to the panel in the binary form; a longer one is left out and the text still goes. */
  voiceReplyAudioMaxBytes: number;
  /** ARMOR_REPORT_TIMEOUT_S, ARMOR_REPORT_QUEUE_MAX, ARMOR_REPORT_REQUESTS_PER_MINUTE: where the limits of the summary of a day and the heat map start (seconds one report may run, reports that may wait, requests a minute); Studio can change them. */
  reportTimeoutS: number;
  reportQueueMax: number;
  reportRequestsPerMinute: number;
  /** ARMOR_VISION_MAX_BYTES and ARMOR_SUMMARY_MAX_BYTES: the most bytes the live vision service may answer for a heat map, and the most a summary command may print. */
  visionMaxBytes: number;
  summaryMaxBytes: number;
  /** ARMOR_INGEST_RECORD_MAX_BYTES and ARMOR_INGEST_RECORD_FILES: the size of the file the optional copy of the node traffic is written to before it rotates, and how many files it keeps (see ingest_recorder.ts). */
  ingestRecordMaxBytes: number;
  ingestRecordFiles: number;
  /** ARMOR_INGEST_RECORD_DOWNLOADS_PER_HOUR: how many times an administrator may download a file of the copy of the node traffic in an hour (the route answers only while the copy is on). */
  ingestRecordDownloadsPerHour: number;
  /** ARMOR_VISION_SERVICE_URL: where the live ARMOR-VISION service listens (the heat map is asked of it); empty is "not set up". Studio can change it. */
  visionServiceUrl: string;
  /** ARMOR_VISION_SERVICE_TOKEN or the file named by ARMOR_VISION_SERVICE_TOKEN_FILE: the token sent to the vision service, and only to it. Empty: none. It is never shown, logged or put in the settings. */
  visionServiceToken: string;
  /** ARMOR_METRICS_TOKEN or the file named by ARMOR_METRICS_TOKEN_FILE: the bearer token GET /metrics asks for. Empty: the page is never served. Never shown or logged. */
  metricsToken: string;
  /** ARMOR_HEARTBEAT_URL: the address the dead-man ping asks while the option heartbeat.enabled is on; empty: none. ARMOR_HEARTBEAT_INTERVAL_S: seconds between pings. */
  heartbeatUrl: string;
  heartbeatIntervalS: number;
  /** ARMOR_ALARM_STATE_KEY_FILE: the file with the key of the installation (64 hex characters) that signs the alarm states while server.alarm_state_signature is on; default alarm-state.key in the data directory, made the first time it is needed. */
  alarmStateKeyFile: string;
  /** The daily log (see daily_log.ts): where the days kept, the two sampling intervals and the false-alarm window start (Studio can change them), and the bounds only the environment sets. */
  dailyLogDays: number;
  dailyLogReadingEveryS: number;
  dailyLogPowerEveryS: number;
  dailyFalseAlarmS: number;
  dailyLogMaxEvents: number;
  dailyLogMaxBytes: number;
  dailyLogSensors: string[];
  /** ARMOR_ALARM_SOUND_MAX_BYTES: the most samples a sound an administrator uploads for an alarm origin may have; 128000 bytes is 4 seconds of 16 kHz 16-bit mono. */
  alarmSoundMaxBytes: number;
  /**
   * The two reports made by the Python projects of the family, run as a command (see reports.ts) only when an administrator turns on the option summary.daily or vision.heatmap:
   * ARMOR_PYTHON (the interpreter), ARMOR_DAILY_SUMMARY_AI_DIR (the checkout or install of ARMOR-SERVER-AI) and ARMOR_DAILY_SUMMARY_CONFIG (its settings file for the summary). The heat map is not
   * a command: it is asked of the live service of ARMOR-VISION (visionServiceUrl). An empty one is "not set up".
   */
  reports: { python: string; dailySummaryAiDir: string; dailySummaryConfig: string; };
  /** Where a request comes from (see origin.ts): the house and its VPN are local, the rest is remote. */
  localNetworks: ReturnType<typeof parseRanges>;
  vpnNetworks: ReturnType<typeof parseRanges>;
  /** When the second factor is asked: never unless the person turned it on, from outside the house, or always. */
  totpPolicy: "off" | "remote" | "always";
  /** A session that came from outside the house: how long it lives, how long it may sit unused, and how long a new proof of identity allows critical actions. */
  remoteSessionTtlMs: number;
  remoteIdleMs: number;
  elevationMs: number;
  /** Tell the places the alarms go to when someone signs in from outside the house from a place that person had not signed in from before. */
  loginAlerts: boolean;
  /** What a session from outside the house may do: everything (`full`, the critical things after a new proof), operate the alarm and look (`operate`) or only look (`view`). */
  remotePolicy: "full" | "operate" | "view";
  studioOrigins: string[];
  cookieSecure: boolean;
  dataDir: string;
  ffmpegPath: string;
  maxMjpegRelays: number;
  /** Pictures a second and widest picture of the live video the console shows (see media/relay.ts). */
  liveFps: number;
  liveWidth: number;
  /** The lighter live picture for a slow link: pictures a second and width (ARMOR_LIVE_LOW_FPS 1 to 30, default 4; ARMOR_LIVE_LOW_WIDTH 160 to 1920, default 480). */
  liveLowFps: number;
  liveLowWidth: number;
  /** Push as data only (ARMOR_FCM_DATA_ONLY=1): the phone writes the notice in its own language, once per event; off by default because an app from before it shows nothing for such a message. */
  fcmDataOnly: boolean;
  /** The MaxMind DB file with countries (ARMOR_GEOIP_DB, e.g. the free GeoLite2 Country the owner downloads): off when empty. Read only from disk; nothing is asked of the network. */
  geoipDb: string | null;
  /** ARMOR_LAN_CA_FILE: the public certificate of the local CA of the LAN (PEM; what ARMOR-DEVOPS scripts/armor_lan_cert.py export-ca writes), served to an administrator while network.lan_ca is on. Empty: none. A file with a private key in it is never served. */
  lanCaFile: string | null;
  maxMediaBytes: number;
  mediaRetentionMs: number;
  /** Their own age limit for snapshots and for recordings (ARMOR_MEDIA_RETENTION_SNAPSHOT_DAYS, ARMOR_MEDIA_RETENTION_RECORDING_DAYS); 0, the default: the general limit above applies. */
  mediaRetentionSnapshotMs: number;
  mediaRetentionRecordingMs: number;
  discoveryCidr: string | null;
  mqtt: { url: string; username?: string; password?: string; /** The authority pinned for an mqtts:// broker (ARMOR_MQTT_CA_FILE), when there is one. */ ca?: MqttCa } | null;
  /** Seconds without a message after which a field node is reported offline. */
  nodeStaleAfterS: number;
  /** Minutes the name the house is reached by from outside may point elsewhere than the public address before it is an alarm (ARMOR_NETWORK_DNS_DWELL_MIN, 1 to 1440; default 30). */
  networkDnsDwellMin: number;
  /** How long, at most, a node's own announcement of planned maintenance holds back its offline alerts (ARMOR_NODE_MAINTENANCE_MAX_S, 60 to 3600; default 600). */
  nodeMaintenanceMaxS: number;
  /** Milliseconds a two-target condition must persist before it becomes "high" (0 = immediately). */
  alertDwellMs: number;
  /** Minutes a critical alarm may wait unseen before it is told again to every place (0 = never). */
  escalateAfterMin: number;
  /** How many targets at once, while armed, make a node's alert "high" (an intrusion): 1 by default, so that a lone intruder is one; 2 to ignore a single target (a pet). */
  alertMinTargets: number;
  /** Seconds between camera reachability checks (0 disables the watchdog). */
  cameraCheckS: number;
  /** Where alarms are POSTed (signed with `alertWebhookSecret` when set); null when unused. */
  alertWebhookUrl: string | null;
  alertWebhookSecret: string;
  /** A Telegram chat that gets the alarms, through a bot of the installation; null when unused. */
  telegram: { token: string; chatIds: string[] } | null;
  /** ntfy: the address of the topic and, for a protected one, a token. */
  ntfy: { url: string; token: string } | null;
  /** Push through Firebase Cloud Messaging: the path of the service account file of the installation's own Firebase project; null: off. */
  fcmServiceAccount: string | null;
  /** Home Assistant: its address and the id of the webhook an automation listens on; null when unused. */
  homeAssistant: { url: string; webhookId: string } | null;
  /** The language the alarm sentences (Telegram, Home Assistant) are told in. */
  alertLanguage: AlertLanguage;
  /** Whether this server may send a command to the switch of an electrical node. Off unless ARMOR_ELECTRICAL_SWITCHING=1; even then the node has to allow it too. */
  electricalSwitching: boolean;
  /** Whether this server may send a gateway node an order to write to a Pylontech battery (clock, counters, limits, outputs, serial number, firmware). Off unless ARMOR_BATTERY_WRITE=1; even then the node and the broker have to allow it too. */
  batteryWrite: boolean;
  /** Whether Studio and the phone may ask the maintenance agent to update this machine's programs with the engine of the updater (a preview, then an apply with the project typed). Off unless ARMOR_CM5_UPDATE=1. */
  cm5Update: boolean;
  /** Whether this server may arm and disarm the panel of an alarm node. Off unless ARMOR_ALARM_COMMANDS=1; even then the node and the broker have to allow it too. */
  alarmCommands: boolean;
  /** ARMOR_DISARM_PIN=required: disarming from Studio, the phone or the wall panel needs the PIN of the signed-in user, and a user without a PIN cannot disarm. Otherwise a PIN is asked only of users who have one. */
  disarmPinRequired: boolean;
  /** What ARMOR_DISARM_PIN fixes when it is set (`required` = always, any other value = if_set); undefined when it is not set, and then the setting `alarm.disarm_pin` of Studio decides. */
  disarmPinEnv: "always" | "if_set" | undefined;
  /**
   * ARMOR_CONTROL_DISARM=1: the control token may disarm (POST /api/v1/control/disarm) even while ARMOR_DISARM_PIN=required. That route carries no PIN and no person, so with the PIN
   * required it is shut unless the installation says it wants it (a script that must be able to disarm).
   */
  controlDisarm: boolean;
  /** ARMOR_EVIDENCE_KEY: the key that signs the proofs of custody. When it is not set the camera key signs them (which is the control token when no camera key is set either, as before). */
  evidenceKey: string | null;
  /**
   * ARMOR_TRUST_PROXY: how many proxies (a number), which proxies (an address, a subnet, or "loopback, uniquelocal") stand in front of this server and may say, in X-Forwarded-For, who the
   * client is. Without it every client behind a reverse proxy (Studio's nginx in Docker) has the proxy's address, and the rate limits of the sign-in count everybody as one. false when not set.
   */
  trustProxy: boolean | number | string;
  /** Home Assistant's MQTT discovery of what the nodes report (read-only sensors): off unless ARMOR_HA_DISCOVERY=1; the prefix is Home Assistant's (default "homeassistant"). See ha_discovery.ts. */
  haDiscovery: { prefix: string } | null;
  /** The admin agent (ARMOR-DEVOPS): where its Unix socket is and the token it wants; null when this install has no agent, and Studio then cannot administer services. */
  admin: { socketPath: string; token: string } | null;
  /** The maintenance agent (ARMOR-DEVOPS): updates from GitHub, the system's updates and the root console; null when this install has none. */
  maintenance: { socketPath: string; token: string } | null;
  /** The voice gateway (ARMOR-VOICE-AI): its address on this machine and the token it wants; null when this install has none, and written and spoken commands then say so. */
  voice: { url: string; token: string } | null;
  /** The token of the observation service (ARMOR-SERVER-AI); it opens only the /api/v1/ai routes. Null when this install has none. */
  aiToken: string | null;
  /** Set only when both TLS_CERT_PATH and TLS_KEY_PATH are configured - see readConfig's own check. Switches the shared REST+WebSocket listener to HTTPS/WSS (app.ts); off (plain HTTP/WS) by default, unchanged from before this existed. */
  tls: { certPath: string; keyPath: string } | null;
  /** Problems that do not stop a loopback-only server but should be fixed. */
  warnings: string[];
};

export const isLoopbackHost = (host: string): boolean => host === "localhost" || host === "::1" || /^127\./.test(host);

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

/** Load a local `.env` into `env` without overriding values already present. */
export function loadDotEnv(file: string, env: Env = process.env): void {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; /* A managed deployment may have no .env. */ }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (env[key]) continue;
    let value = line.slice(separator + 1).trim();
    // A value in quotes (ARMOR_STUDIO_PASSWORD="abc") is the text inside them, quotes excluded.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    env[key] = value;
  }
}

const ranges = (env: Env, key: string, fallback: string) => {
  try { return parseRanges(env[key]?.trim() || fallback); } catch (error) { throw new ConfigError(`${key}: ${error instanceof Error ? error.message : "not a list of address ranges"}`); }
};
const oneOf = <T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T => {
  const value = (env[key] ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new ConfigError(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
};
const visionServiceUrl = (env: Env): string => {
  const raw = env.ARMOR_VISION_SERVICE_URL?.trim() ?? "";
  if (raw !== "" && parseVisionServiceUrl(raw) === undefined) throw new ConfigError("ARMOR_VISION_SERVICE_URL must be an http or https address such as http://127.0.0.1:8765 (no sign-in, path or query in it)");
  return raw;
};

const visionServiceToken = (env: Env): string => {
  const direct = env.ARMOR_VISION_SERVICE_TOKEN?.trim() ?? "", file = env.ARMOR_VISION_SERVICE_TOKEN_FILE?.trim() ?? "";
  if (direct && file) throw new ConfigError("give the vision service token once: ARMOR_VISION_SERVICE_TOKEN or ARMOR_VISION_SERVICE_TOKEN_FILE, not both");
  let token = direct;
  if (file) {
    try { token = fs.readFileSync(file, "utf8").trim(); } catch { throw new ConfigError("ARMOR_VISION_SERVICE_TOKEN_FILE cannot be read"); }
  }
  if (token && !/^[A-Za-z0-9._~+/=-]{24,200}$/.test(token)) throw new ConfigError("the vision service token must be 24 to 200 characters of letters, digits and . _ ~ + / = -");
  return token;
};

const metricsToken = (env: Env): string => {
  const direct = env.ARMOR_METRICS_TOKEN?.trim() ?? "", file = env.ARMOR_METRICS_TOKEN_FILE?.trim() ?? "";
  if (direct && file) throw new ConfigError("give the metrics token once: ARMOR_METRICS_TOKEN or ARMOR_METRICS_TOKEN_FILE, not both");
  let token = direct;
  if (file) {
    try { token = fs.readFileSync(file, "utf8").trim(); } catch { throw new ConfigError("ARMOR_METRICS_TOKEN_FILE cannot be read"); }
  }
  if (token && !/^[A-Za-z0-9._~+/=-]{24,200}$/.test(token)) throw new ConfigError("the metrics token must be 24 to 200 characters of letters, digits and . _ ~ + / = -");
  return token;
};

const heartbeatUrl = (env: Env): string => {
  const raw = env.ARMOR_HEARTBEAT_URL?.trim() ?? "";
  if (raw !== "" && parseHeartbeatUrl(raw) === undefined) throw new ConfigError("ARMOR_HEARTBEAT_URL must be an http or https address with no sign-in in it (at most 300 characters)");
  return raw;
};

const dailyLogSensors = (env: Env): string[] => {
  const raw = env.ARMOR_DAILY_LOG_SENSORS?.trim();
  if (!raw) return [...DEFAULT_SENSOR_FIELDS];
  const names = raw.split(",").map(name => name.trim()).filter(Boolean);
  if (!names.length || names.length > 32 || names.some(name => !/^[a-z][a-z0-9_]{0,31}$/.test(name))) throw new ConfigError("ARMOR_DAILY_LOG_SENSORS must be a list of up to 32 field names (lower case letters, digits and _), separated by commas");
  return names;
};

const integer = (env: Env, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  return value;
};

const secret = (env: Env, key: string): string => {
  const value = env[key]?.trim() ?? "";
  if (!value) throw new ConfigError(`${key} must be configured`);
  if (value.length < MIN_SECRET_LENGTH) throw new ConfigError(`${key} must be at least ${MIN_SECRET_LENGTH} characters`);
  return value;
};

/** A plain http(s) origin without credentials, path, query or fragment. */
export function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch { return null; }
}

/** Where the alarms go (webhook, Telegram, ntfy, Firebase, Home Assistant) and the language they are told in. */
function readChannels(env: Env, warnings: string[]) {
  const webhookRaw = env.ARMOR_ALERT_WEBHOOK_URL?.trim() ?? "";
  let alertWebhookUrl: string | null = null;
  if (webhookRaw) {
    let parsed: URL | undefined;
    try { parsed = new URL(webhookRaw); } catch { /* reported below */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash) {
      throw new ConfigError("ARMOR_ALERT_WEBHOOK_URL must be a plain http(s) URL without credentials");
    }
    alertWebhookUrl = parsed.toString();
  }
  const telegramToken = env.ARMOR_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const telegramChats = (env.ARMOR_TELEGRAM_CHAT_IDS ?? "").split(",").map(item => item.trim()).filter(Boolean);
  let telegram: ArmorConfig["telegram"] = null;
  if (telegramToken || telegramChats.length > 0) {
    if (!validTelegramToken(telegramToken)) throw new ConfigError("ARMOR_TELEGRAM_BOT_TOKEN must be the token BotFather gave (digits, a colon and letters)");
    if (telegramChats.length === 0 || telegramChats.length > 10 || !telegramChats.every(validTelegramChat)) throw new ConfigError("ARMOR_TELEGRAM_CHAT_IDS must be one to ten chat ids (numbers) or @channel names, separated by commas");
    telegram = { token: telegramToken, chatIds: telegramChats };
  }
  const fcmServiceAccount = env.ARMOR_FCM_SERVICE_ACCOUNT?.trim() || null;
  const ntfyRaw = env.ARMOR_NTFY_URL?.trim() ?? "";
  let ntfy: ArmorConfig["ntfy"] = null;
  if (ntfyRaw) {
    let parsed: URL | undefined;
    try { parsed = new URL(ntfyRaw); } catch { /* reported below */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.pathname.length < 2) {
      throw new ConfigError("ARMOR_NTFY_URL must be the address of a ntfy topic, such as https://ntfy.sh/my-armor-topic");
    }
    ntfy = { url: parsed.toString(), token: env.ARMOR_NTFY_TOKEN?.trim() ?? "" };
  }
  const haUrlRaw = env.ARMOR_HOMEASSISTANT_URL?.trim() ?? "", haWebhookId = env.ARMOR_HOMEASSISTANT_WEBHOOK_ID?.trim() ?? "";
  let homeAssistant: ArmorConfig["homeAssistant"] = null;
  if (haUrlRaw || haWebhookId) {
    let parsed: URL | undefined;
    try { parsed = new URL(haUrlRaw); } catch { /* reported below */ }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new ConfigError("ARMOR_HOMEASSISTANT_URL must be the plain address of Home Assistant, such as http://192.168.0.20:8123");
    }
    if (!validWebhookId(haWebhookId)) throw new ConfigError("ARMOR_HOMEASSISTANT_WEBHOOK_ID must be the id of a Home Assistant webhook (letters, digits, - and _, 8 to 128 characters)");
    homeAssistant = { url: parsed.origin, webhookId: haWebhookId };
  }
  const languageRaw = env.ARMOR_ALERT_LANGUAGE?.trim().toLowerCase() ?? "es";
  if (!isAlertLanguage(languageRaw)) throw new ConfigError(`ARMOR_ALERT_LANGUAGE must be one of ${ALERT_LANGUAGES.join(", ")}`);
  const alertLanguage: AlertLanguage = languageRaw;
  const alertWebhookSecret = env.ARMOR_ALERT_WEBHOOK_SECRET?.trim() ?? "";
  if (alertWebhookUrl && !alertWebhookSecret) warnings.push("ARMOR_ALERT_WEBHOOK_SECRET is not set; alarm calls will not be signed");
  if (alertWebhookSecret) secret(env, "ARMOR_ALERT_WEBHOOK_SECRET");

  return { alertWebhookUrl, alertWebhookSecret, telegram, ntfy, fcmServiceAccount, homeAssistant, alertLanguage };
}

/** The agents and services on this machine: the admin and maintenance agents of ARMOR-DEVOPS, the voice gateway and the observation service. */
function readAgents(env: Env) {
  const adminSocket = env.ARMOR_ADMIN_SOCKET?.trim() ?? "", adminToken = env.ARMOR_ADMIN_TOKEN?.trim() ?? "";
  if (adminSocket && adminToken.length < MIN_SECRET_LENGTH) throw new ConfigError(`ARMOR_ADMIN_TOKEN must be at least ${MIN_SECRET_LENGTH} characters when ARMOR_ADMIN_SOCKET is set`);
  const admin = adminSocket ? { socketPath: adminSocket, token: adminToken } : null;
  const maintSocket = env.ARMOR_MAINT_SOCKET?.trim() ?? "", maintToken = env.ARMOR_MAINT_TOKEN?.trim() ?? "";
  if (maintSocket && maintToken.length < MIN_SECRET_LENGTH) throw new ConfigError(`ARMOR_MAINT_TOKEN must be at least ${MIN_SECRET_LENGTH} characters when ARMOR_MAINT_SOCKET is set`);
  const maintenance = maintSocket ? { socketPath: maintSocket, token: maintToken } : null;
  const voiceUrl = env.ARMOR_VOICE_URL?.trim() ?? "", voiceToken = env.ARMOR_VOICE_TOKEN?.trim() ?? "";
  if (voiceUrl && voiceToken.length < MIN_SECRET_LENGTH) throw new ConfigError(`ARMOR_VOICE_TOKEN must be at least ${MIN_SECRET_LENGTH} characters when ARMOR_VOICE_URL is set`);
  const voice = voiceUrl ? { url: voiceUrl, token: voiceToken } : null;
  const aiTokenRaw = env.ARMOR_AI_TOKEN?.trim() ?? "";
  if (aiTokenRaw && aiTokenRaw.length < MIN_SECRET_LENGTH) throw new ConfigError(`ARMOR_AI_TOKEN must be at least ${MIN_SECRET_LENGTH} characters`);
  const aiToken = aiTokenRaw || null;
  return { admin, maintenance, voice, aiToken };
}

/** The server's own HTTPS listener. */
function readTls(env: Env): ArmorConfig["tls"] {
  // Off (plain HTTP/WS) by default - unchanged for every deployment that
  // does not opt in, same convention as HYDRA-UMC-SERVER's own
  // TLS_CERT_PATH/TLS_KEY_PATH. Unlike that one, exactly one of the two
  // set is a ConfigError here rather than a silent fallback to plain
  // HTTP - a deployer who set only one (a typo'd variable name) asked for
  // TLS and would otherwise serve arm/disarm and camera credentials over
  // plaintext while believing the server was on HTTPS. The path itself is
  // only checked for existence here (fs.readFileSync at server start-up
  // reports a real, specific error for anything else - permissions, an
  // expired/malformed PEM, ...).
  const tlsCertPath = env.TLS_CERT_PATH?.trim() || "";
  const tlsKeyPath = env.TLS_KEY_PATH?.trim() || "";
  if (!!tlsCertPath !== !!tlsKeyPath) {
    throw new ConfigError("TLS_CERT_PATH and TLS_KEY_PATH must both be set to enable HTTPS, or both left unset to keep plain HTTP");
  }
  if (tlsCertPath && !fs.existsSync(tlsCertPath)) throw new ConfigError(`TLS_CERT_PATH does not exist: ${tlsCertPath}`);
  if (tlsKeyPath && !fs.existsSync(tlsKeyPath)) throw new ConfigError(`TLS_KEY_PATH does not exist: ${tlsKeyPath}`);
  const tls = tlsCertPath && tlsKeyPath ? { certPath: tlsCertPath, keyPath: tlsKeyPath } : null;

  return tls;
}

/** The link to the broker. */
function readMqtt(env: Env): { mqttUrl: string | undefined; mqttCa: MqttCa | undefined } {
  const mqttUrl = env.ARMOR_MQTT_URL?.trim();
  // The optional encryption of the link to the broker (see mqtt_tls.ts): a pinned authority only makes sense with an mqtts:// address, and a mistake here must stop the server rather than
  // leave it talking plain MQTT while its owner believes it is encrypted.
  const mqttCaFile = env.ARMOR_MQTT_CA_FILE?.trim() ?? "";
  let mqttCa: MqttCa | undefined;
  if (mqttCaFile) {
    if (!mqttUrl) throw new ConfigError("ARMOR_MQTT_CA_FILE is set but ARMOR_MQTT_URL is not");
    if (!isTlsUrl(mqttUrl)) throw new ConfigError("ARMOR_MQTT_CA_FILE needs an mqtts:// address in ARMOR_MQTT_URL (with mqtt:// the link would stay unencrypted)");
    try { mqttCa = readCaFile(mqttCaFile); } catch (error) { throw new ConfigError(`ARMOR_MQTT_CA_FILE (${mqttCaFile}): ${error instanceof Error ? error.message : "it cannot be used"}`); }
  }
  return { mqttUrl, mqttCa };
}

/** A path from the environment as an absolute one; "" when it is not set. */
const pathOf = (value: string | undefined): string => (value?.trim() ? path.resolve(value.trim()) : "");

export function readConfig(env: Env = process.env): ArmorConfig {
  const ingestToken = secret(env, "ARMOR_INGEST_TOKEN");
  const controlToken = secret(env, "ARMOR_CONTROL_TOKEN");
  const operatorToken = env.ARMOR_OPERATOR_TOKEN?.trim() ? secret(env, "ARMOR_OPERATOR_TOKEN") : controlToken;
  const configuredKey = env.ARMOR_CAMERA_CONFIG_KEY?.trim();
  const cameraConfigKey = configuredKey ? secret(env, "ARMOR_CAMERA_CONFIG_KEY") : controlToken;
  const studioUsername = env.ARMOR_STUDIO_USERNAME?.trim() ?? "";
  const studioPassword = env.ARMOR_STUDIO_PASSWORD ?? "";
  if (!studioUsername || !studioPassword) throw new ConfigError("ARMOR_STUDIO_USERNAME and ARMOR_STUDIO_PASSWORD must be configured");
  const host = env.ARMOR_HOST?.trim() || "127.0.0.1";
  const warnings: string[] = [];
  if (studioPassword.length < 12) {
    // A short password is tolerated on a loopback-only development server, never on a reachable one.
    if (!isLoopbackHost(host)) throw new ConfigError("ARMOR_STUDIO_PASSWORD must be at least 12 characters when the server is reachable from the network");
    warnings.push("ARMOR_STUDIO_PASSWORD is shorter than 12 characters; use a longer one before exposing this server");
  }

  const origins = new Set<string>(["http://127.0.0.1:5178", "http://localhost:5178"]);
  for (const candidate of (env.ARMOR_STUDIO_ORIGIN ?? "").split(",").map(item => item.trim()).filter(Boolean)) {
    const origin = parseOrigin(candidate);
    if (!origin) throw new ConfigError(`ARMOR_STUDIO_ORIGIN contains an invalid origin: ${candidate}`);
    origins.add(origin);
  }

  const cidr = env.ARMOR_CAMERA_DISCOVERY_CIDR?.trim() || null;
  if (cidr && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/24$/.test(cidr)) throw new ConfigError("ARMOR_CAMERA_DISCOVERY_CIDR must use an IPv4 /24 CIDR");

  const { alertWebhookUrl, alertWebhookSecret, telegram, ntfy, fcmServiceAccount, homeAssistant, alertLanguage } = readChannels(env, warnings);
  const { admin, maintenance, voice, aiToken } = readAgents(env);
  const electricalSwitching = env.ARMOR_ELECTRICAL_SWITCHING === "1";
  const batteryWrite = env.ARMOR_BATTERY_WRITE === "1";
  const cm5Update = env.ARMOR_CM5_UPDATE === "1";
  const alarmCommands = env.ARMOR_ALARM_COMMANDS === "1";
  const disarmPinRequired = env.ARMOR_DISARM_PIN?.trim() === "required";
  const disarmPinEnv = disarmPinRequired ? "always" : env.ARMOR_DISARM_PIN?.trim() ? "if_set" : undefined;
  const controlDisarm = env.ARMOR_CONTROL_DISARM === "1";
  const evidenceKey = env.ARMOR_EVIDENCE_KEY?.trim() ? secret(env, "ARMOR_EVIDENCE_KEY") : null;
  const trustRaw = env.ARMOR_TRUST_PROXY?.trim() ?? "";
  if (trustRaw && !/^[A-Za-z0-9.:,_/ -]{1,200}$/.test(trustRaw)) throw new ConfigError("ARMOR_TRUST_PROXY is a number of proxies, or addresses, subnets or names (such as loopback, uniquelocal) separated by commas");
  const trustProxy: boolean | number | string = trustRaw === "" || trustRaw === "false" || trustRaw === "0" ? false : trustRaw === "true" ? true : /^\d+$/.test(trustRaw) ? Number(trustRaw) : trustRaw;
  // The tokens are different secrets with different power: the ingest token sits in the flash of every node, so if it were also the control token whoever read one board could arm and
  // disarm the house. A value copied into two variables is refused, not noticed in an incident.
  const secrets: Array<[string, string]> = [["ARMOR_INGEST_TOKEN", ingestToken], ["ARMOR_CONTROL_TOKEN", controlToken]];
  if (env.ARMOR_OPERATOR_TOKEN?.trim()) secrets.push(["ARMOR_OPERATOR_TOKEN", operatorToken]);
  if (configuredKey) secrets.push(["ARMOR_CAMERA_CONFIG_KEY", cameraConfigKey]);
  if (env.ARMOR_AI_TOKEN?.trim()) secrets.push(["ARMOR_AI_TOKEN", env.ARMOR_AI_TOKEN.trim()]);
  if (evidenceKey) secrets.push(["ARMOR_EVIDENCE_KEY", evidenceKey]);
  for (let first = 0; first < secrets.length; first += 1) for (let second = first + 1; second < secrets.length; second += 1) {
    if (secrets[first]![1] === secrets[second]![1]) throw new ConfigError(`${secrets[first]![0]} and ${secrets[second]![0]} must be different values`);
  }
  if (!env.ARMOR_OPERATOR_TOKEN?.trim() && !isLoopbackHost(host)) warnings.push("ARMOR_OPERATOR_TOKEN is not set: the operator token is the control token. Set a different one so that a service with operator rights cannot also arm and disarm.");
  if (!disarmPinRequired) warnings.push("ARMOR_DISARM_PIN is not \"required\": unless the setting alarm.disarm_pin (Studio, Security) is \"always\", anyone signed in as a user without a PIN can disarm the system, and with \"never\" nobody is asked for a PIN; set a PIN for each user and choose \"always\" there, or ARMOR_DISARM_PIN=required, which wins over the setting.");
  const haPrefix = (env.ARMOR_HA_DISCOVERY_PREFIX ?? "homeassistant").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(haPrefix)) throw new ConfigError("ARMOR_HA_DISCOVERY_PREFIX is one word of letters, digits, - and _");
  const haDiscovery = env.ARMOR_HA_DISCOVERY === "1" ? { prefix: haPrefix } : null;
  if (alarmCommands) warnings.push("ARMOR_ALARM_COMMANDS=1: this server may arm and disarm the panels of alarm nodes, and a disarm from here carries no PIN; keep the broker's access list and the nodes' own setting as strict as you want this to be.");
  if (cm5Update) warnings.push("ARMOR_CM5_UPDATE=1: an administrator may ask, from Studio or the phone, to update this machine's programs through the maintenance agent (a preview first, then the project typed again, a second proof of identity and a signed release are all required)");
  if (batteryWrite) warnings.push("ARMOR_BATTERY_WRITE=1: this server may order a gateway node to change what a Pylontech battery keeps (clock, counters, limits, outputs, serial number, firmware); some of it cannot be undone and can void the maker's warranty, and only an administrator who has just proved themselves again, with the battery's serial number typed, can do it");
  if (electricalSwitching) warnings.push("ARMOR_ELECTRICAL_SWITCHING=1: this server may send commands to the switches of electrical nodes; that is only for a bench, a lamp and a person present, until the installation has its own protections");

  const tls = readTls(env);
  const { mqttUrl, mqttCa } = readMqtt(env);
  // What an administrator set from Studio (the address, the port, the port of Studio) wins over the environment; see connection.ts.
  const dataDir = path.resolve(env.ARMOR_DATA_DIR ?? "data");
  const saved = readConnection(dataDir);
  const effectiveHost = saved.host && (isLoopbackHost(saved.host) || studioPassword.length >= 12) ? saved.host : host;
  return {
    host: effectiveHost,
    port: saved.port ?? integer(env, "ARMOR_PORT", ARMOR_PORTS.server, 1, 65535),
    ingestToken, ingestStrict: env.ARMOR_INGEST_STRICT === "1", controlToken, operatorToken, cameraConfigKey,
    cameraKeyIsFallback: !configuredKey,
    studioUsername, studioPassword, passwordMinLength: isLoopbackHost(effectiveHost) ? 8 : 12, resetStudioPassword: env.ARMOR_STUDIO_RESET_PASSWORD === "1",
    studioSessionTtlMs: integer(env, "ARMOR_STUDIO_SESSION_TTL_MS", 7 * 86_400_000, 60_000, 30 * 86_400_000),
    operatorSessionTtlMs: integer(env, "ARMOR_OPERATOR_SESSION_TTL_MS", 28_800_000, 60_000, 7 * 86_400_000),
    voiceTurnMaxBytes: integer(env, "ARMOR_VOICE_TURN_MAX_BYTES", 480_000, 3_200, 1_920_000),
    voiceReplyAudioMaxBytes: integer(env, "ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES", 200_000, 3_200, 1_000_000),
    reportTimeoutS: integer(env, "ARMOR_REPORT_TIMEOUT_S", 20, 5, 120),
    reportQueueMax: integer(env, "ARMOR_REPORT_QUEUE_MAX", 3, 1, 10),
    reportRequestsPerMinute: integer(env, "ARMOR_REPORT_REQUESTS_PER_MINUTE", 30, 1, 300),
    visionMaxBytes: integer(env, "ARMOR_VISION_MAX_BYTES", 16 * 1024 * 1024, 65_536, 64 * 1024 * 1024),
    summaryMaxBytes: integer(env, "ARMOR_SUMMARY_MAX_BYTES", 4 * 1024 * 1024, 65_536, 64 * 1024 * 1024),
    ingestRecordMaxBytes: integer(env, "ARMOR_INGEST_RECORD_MAX_BYTES", 8 * 1024 * 1024, 65_536, 256 * 1024 * 1024),
    ingestRecordFiles: integer(env, "ARMOR_INGEST_RECORD_FILES", 4, 1, 20),
    ingestRecordDownloadsPerHour: integer(env, "ARMOR_INGEST_RECORD_DOWNLOADS_PER_HOUR", 6, 1, 600),
    visionServiceUrl: visionServiceUrl(env),
    visionServiceToken: visionServiceToken(env),
    metricsToken: metricsToken(env),
    heartbeatUrl: heartbeatUrl(env),
    heartbeatIntervalS: integer(env, "ARMOR_HEARTBEAT_INTERVAL_S", 60, 10, 3600),
    alarmStateKeyFile: path.resolve(env.ARMOR_ALARM_STATE_KEY_FILE?.trim() || path.join(dataDir, "alarm-state.key")),
    dailyLogDays: integer(env, "ARMOR_DAILY_LOG_DAYS", 14, 1, 90),
    dailyLogReadingEveryS: integer(env, "ARMOR_DAILY_LOG_READING_EVERY_S", 300, 10, 3600),
    dailyLogPowerEveryS: integer(env, "ARMOR_DAILY_LOG_POWER_EVERY_S", 60, 5, 3600),
    dailyFalseAlarmS: integer(env, "ARMOR_DAILY_FALSE_ALARM_S", 60, 0, 600),
    dailyLogMaxEvents: integer(env, "ARMOR_DAILY_LOG_MAX_EVENTS", 5000, 100, 50_000),
    dailyLogMaxBytes: integer(env, "ARMOR_DAILY_LOG_MAX_BYTES", 4 * 1024 * 1024, 65_536, 64 * 1024 * 1024),
    dailyLogSensors: dailyLogSensors(env),
    alarmSoundMaxBytes: integer(env, "ARMOR_ALARM_SOUND_MAX_BYTES", 128_000, 3_200, 256_000),
    reports: {
      python: env.ARMOR_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3"),
      dailySummaryAiDir: pathOf(env.ARMOR_DAILY_SUMMARY_AI_DIR), dailySummaryConfig: pathOf(env.ARMOR_DAILY_SUMMARY_CONFIG),
    },
    localNetworks: ranges(env, "ARMOR_LOCAL_NETWORKS", DEFAULT_LOCAL_NETWORKS), vpnNetworks: ranges(env, "ARMOR_VPN_NETWORKS", ""),
    totpPolicy: oneOf(env, "ARMOR_TOTP_REQUIRED", ["off", "remote", "always"] as const, "off"),
    remoteSessionTtlMs: integer(env, "ARMOR_REMOTE_SESSION_TTL_MS", 12 * 3_600_000, 60_000, 30 * 86_400_000),
    remoteIdleMs: integer(env, "ARMOR_REMOTE_IDLE_MS", 30 * 60_000, 60_000, 7 * 86_400_000),
    loginAlerts: env.ARMOR_LOGIN_ALERTS !== "0",
    elevationMs: integer(env, "ARMOR_ELEVATION_MS", 5 * 60_000, 30_000, 3_600_000),
    remotePolicy: oneOf(env, "ARMOR_REMOTE_POLICY", ["full", "operate", "view"] as const, "full"),
    studioOrigins: originsWithStudioPort([...origins], saved.studio_port),
    cookieSecure: env.ARMOR_COOKIE_SECURE === "1" || ((env.ARMOR_COOKIE_SECURE === undefined || env.ARMOR_COOKIE_SECURE.trim() === "") && (tls !== null || (env.ARMOR_PUBLIC_ORIGIN ?? "").trim().startsWith("https://"))),
    dataDir,
    ffmpegPath: env.ARMOR_FFMPEG_PATH?.trim() ?? "",
    maxMjpegRelays: integer(env, "ARMOR_MAX_MJPEG_RELAYS", 8, 1, 64),
    liveFps: integer(env, "ARMOR_LIVE_FPS", 12, 1, 30),
    liveWidth: integer(env, "ARMOR_LIVE_WIDTH", 960, 160, 1920),
    liveLowFps: integer(env, "ARMOR_LIVE_LOW_FPS", 4, 1, 30),
    liveLowWidth: integer(env, "ARMOR_LIVE_LOW_WIDTH", 480, 160, 1920),
    fcmDataOnly: env.ARMOR_FCM_DATA_ONLY === "1",
    lanCaFile: env.ARMOR_LAN_CA_FILE?.trim() ? path.resolve(env.ARMOR_LAN_CA_FILE.trim()) : null,
    geoipDb: env.ARMOR_GEOIP_DB?.trim() ? path.resolve(env.ARMOR_GEOIP_DB.trim()) : null,
    maxMediaBytes: integer(env, "ARMOR_MEDIA_MAX_BYTES", 20 * 1024 ** 3, 64 * 1024 ** 2, Number.MAX_SAFE_INTEGER),
    mediaRetentionMs: integer(env, "ARMOR_MEDIA_RETENTION_DAYS", 30, 0, 3650) * 86_400_000,
    mediaRetentionSnapshotMs: integer(env, "ARMOR_MEDIA_RETENTION_SNAPSHOT_DAYS", 0, 0, 3650) * 86_400_000,
    mediaRetentionRecordingMs: integer(env, "ARMOR_MEDIA_RETENTION_RECORDING_DAYS", 0, 0, 3650) * 86_400_000,
    discoveryCidr: cidr,
    mqtt: mqttUrl ? { url: mqttUrl, username: env.ARMOR_MQTT_USERNAME?.trim() || undefined, password: env.ARMOR_MQTT_PASSWORD || undefined, ...(mqttCa ? { ca: mqttCa } : {}) } : null,
    nodeStaleAfterS: integer(env, "ARMOR_NODE_STALE_AFTER_S", 30, 5, 3600),
    networkDnsDwellMin: integer(env, "ARMOR_NETWORK_DNS_DWELL_MIN", 30, 1, 1440),
    nodeMaintenanceMaxS: integer(env, "ARMOR_NODE_MAINTENANCE_MAX_S", 600, 60, 3600),
    alertDwellMs: integer(env, "ARMOR_ALERT_DWELL_MS", 2000, 0, 60_000),
    escalateAfterMin: integer(env, "ARMOR_ESCALATE_AFTER_MIN", 0, 0, 1440),
    alertMinTargets: integer(env, "ARMOR_ALERT_MIN_TARGETS", 1, 1, 20),
    cameraCheckS: integer(env, "ARMOR_CAMERA_CHECK_S", 20, 0, 3600),
    alertWebhookUrl, alertWebhookSecret, telegram, ntfy, fcmServiceAccount, homeAssistant, alertLanguage, electricalSwitching, batteryWrite, cm5Update, alarmCommands, disarmPinRequired, disarmPinEnv, controlDisarm, evidenceKey, trustProxy, haDiscovery, admin, maintenance, voice, aiToken,
    tls,
    warnings,
  };
}
