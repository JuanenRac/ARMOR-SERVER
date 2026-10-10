/**
 * A.R.M.O.R. server configuration: one place that reads the environment, checks
 * every value and refuses to start on a weak or inconsistent one.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { isAlertLanguage, type AlertLanguage } from "./alert_text.js";
import { validTelegramChat, validTelegramToken, validWebhookId } from "./channels.js";
import fs from "node:fs";
import path from "node:path";
import { originsWithStudioPort, readConnection } from "./connection.js";

export const MIN_SECRET_LENGTH = 24;

export type ArmorConfig = {
  host: string;
  port: number;
  ingestToken: string;
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
  studioOrigins: string[];
  cookieSecure: boolean;
  dataDir: string;
  ffmpegPath: string;
  maxMjpegRelays: number;
  /** Pictures a second and widest picture of the live video the console shows (see media/relay.ts). */
  liveFps: number;
  liveWidth: number;
  maxMediaBytes: number;
  mediaRetentionMs: number;
  discoveryCidr: string | null;
  mqtt: { url: string; username?: string; password?: string } | null;
  /** Seconds without a message after which a field node is reported offline. */
  nodeStaleAfterS: number;
  /** Milliseconds a two-target condition must persist before it becomes "high" (0 = immediately). */
  alertDwellMs: number;
  /** Seconds between camera reachability checks (0 disables the watchdog). */
  cameraCheckS: number;
  /** Where alarms are POSTed (signed with `alertWebhookSecret` when set); null when unused. */
  alertWebhookUrl: string | null;
  alertWebhookSecret: string;
  /** A Telegram chat that gets the alarms, through a bot of the installation; null when unused. */
  telegram: { token: string; chatIds: string[] } | null;
  /** Home Assistant: its address and the id of the webhook an automation listens on; null when unused. */
  homeAssistant: { url: string; webhookId: string } | null;
  /** The language the alarm sentences (Telegram, Home Assistant) are told in. */
  alertLanguage: AlertLanguage;
  /** Whether this server may send a command to the switch of an electrical node. Off unless ARMOR_ELECTRICAL_SWITCHING=1; even then the node has to allow it too. */
  electricalSwitching: boolean;
  /** Whether this server may arm and disarm the panel of an alarm node. Off unless ARMOR_ALARM_COMMANDS=1; even then the node and the broker have to allow it too. */
  alarmCommands: boolean;
  /** The admin agent (ARMOR-DEVOPS): where its Unix socket is and the token it wants; null when this install has no agent, and Studio then cannot administer services. */
  admin: { socketPath: string; token: string } | null;
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
    if (!env[key]) env[key] = line.slice(separator + 1).trim();
  }
}

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
  if (!isAlertLanguage(languageRaw)) throw new ConfigError("ARMOR_ALERT_LANGUAGE must be one of en, es, de, fr, it, ja, zh");
  const alertLanguage: AlertLanguage = languageRaw;
  const alertWebhookSecret = env.ARMOR_ALERT_WEBHOOK_SECRET?.trim() ?? "";
  if (alertWebhookUrl && !alertWebhookSecret) warnings.push("ARMOR_ALERT_WEBHOOK_SECRET is not set; alarm calls will not be signed");
  if (alertWebhookSecret) secret(env, "ARMOR_ALERT_WEBHOOK_SECRET");

  const adminSocket = env.ARMOR_ADMIN_SOCKET?.trim() ?? "", adminToken = env.ARMOR_ADMIN_TOKEN?.trim() ?? "";
  if (adminSocket && adminToken.length < MIN_SECRET_LENGTH) throw new Error(`ARMOR_ADMIN_TOKEN must be at least ${MIN_SECRET_LENGTH} characters when ARMOR_ADMIN_SOCKET is set`);
  const admin = adminSocket ? { socketPath: adminSocket, token: adminToken } : null;
  const voiceUrl = env.ARMOR_VOICE_URL?.trim() ?? "", voiceToken = env.ARMOR_VOICE_TOKEN?.trim() ?? "";
  if (voiceUrl && voiceToken.length < MIN_SECRET_LENGTH) throw new Error(`ARMOR_VOICE_TOKEN must be at least ${MIN_SECRET_LENGTH} characters when ARMOR_VOICE_URL is set`);
  const voice = voiceUrl ? { url: voiceUrl, token: voiceToken } : null;
  const aiTokenRaw = env.ARMOR_AI_TOKEN?.trim() ?? "";
  if (aiTokenRaw && aiTokenRaw.length < MIN_SECRET_LENGTH) throw new ConfigError(`ARMOR_AI_TOKEN must be at least ${MIN_SECRET_LENGTH} characters`);
  const aiToken = aiTokenRaw || null;
  const electricalSwitching = env.ARMOR_ELECTRICAL_SWITCHING === "1";
  const alarmCommands = env.ARMOR_ALARM_COMMANDS === "1";
  if (alarmCommands) warnings.push("ARMOR_ALARM_COMMANDS=1: this server may arm and disarm the panels of alarm nodes, and a disarm from here carries no PIN; keep the broker's access list and the nodes' own setting as strict as you want this to be.");
  if (electricalSwitching) warnings.push("ARMOR_ELECTRICAL_SWITCHING=1: this server may send commands to the switches of electrical nodes; that is only for a bench, a lamp and a person present, until the installation has its own protections");

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

  const mqttUrl = env.ARMOR_MQTT_URL?.trim();
  // What an administrator set from Studio (the address, the port, the port of Studio) wins over the environment; see connection.ts.
  const dataDir = path.resolve(env.ARMOR_DATA_DIR ?? "data");
  const saved = readConnection(dataDir);
  const effectiveHost = saved.host && (isLoopbackHost(saved.host) || studioPassword.length >= 12) ? saved.host : host;
  return {
    host: effectiveHost,
    port: saved.port ?? integer(env, "ARMOR_PORT", 8080, 1, 65535),
    ingestToken, controlToken, operatorToken, cameraConfigKey,
    cameraKeyIsFallback: !configuredKey,
    studioUsername, studioPassword, passwordMinLength: isLoopbackHost(effectiveHost) ? 8 : 12, resetStudioPassword: env.ARMOR_STUDIO_RESET_PASSWORD === "1",
    studioSessionTtlMs: integer(env, "ARMOR_STUDIO_SESSION_TTL_MS", 7 * 86_400_000, 60_000, 30 * 86_400_000),
    operatorSessionTtlMs: integer(env, "ARMOR_OPERATOR_SESSION_TTL_MS", 28_800_000, 60_000, 7 * 86_400_000),
    studioOrigins: originsWithStudioPort([...origins], saved.studio_port),
    cookieSecure: env.ARMOR_COOKIE_SECURE === "1",
    dataDir,
    ffmpegPath: env.ARMOR_FFMPEG_PATH?.trim() ?? "",
    maxMjpegRelays: integer(env, "ARMOR_MAX_MJPEG_RELAYS", 8, 1, 64),
    liveFps: integer(env, "ARMOR_LIVE_FPS", 12, 1, 30),
    liveWidth: integer(env, "ARMOR_LIVE_WIDTH", 960, 160, 1920),
    maxMediaBytes: integer(env, "ARMOR_MEDIA_MAX_BYTES", 20 * 1024 ** 3, 64 * 1024 ** 2, Number.MAX_SAFE_INTEGER),
    mediaRetentionMs: integer(env, "ARMOR_MEDIA_RETENTION_DAYS", 30, 0, 3650) * 86_400_000,
    discoveryCidr: cidr,
    mqtt: mqttUrl ? { url: mqttUrl, username: env.ARMOR_MQTT_USERNAME?.trim() || undefined, password: env.ARMOR_MQTT_PASSWORD || undefined } : null,
    nodeStaleAfterS: integer(env, "ARMOR_NODE_STALE_AFTER_S", 30, 5, 3600),
    alertDwellMs: integer(env, "ARMOR_ALERT_DWELL_MS", 2000, 0, 60_000),
    cameraCheckS: integer(env, "ARMOR_CAMERA_CHECK_S", 20, 0, 3600),
    alertWebhookUrl, alertWebhookSecret, telegram, homeAssistant, alertLanguage, electricalSwitching, alarmCommands, admin, voice, aiToken,
    tls,
    warnings,
  };
}
