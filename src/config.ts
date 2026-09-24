/**
 * A.R.M.O.R. server configuration: one place that reads the environment, checks
 * every value and refuses to start on a weak or inconsistent one.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

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
  studioSessionTtlMs: number;
  operatorSessionTtlMs: number;
  studioOrigins: string[];
  cookieSecure: boolean;
  dataDir: string;
  ffmpegPath: string;
  maxMjpegRelays: number;
  maxMediaBytes: number;
  mediaRetentionMs: number;
  discoveryCidr: string | null;
  mqtt: { url: string; username?: string; password?: string } | null;
  /** Seconds without a message after which a field node is reported offline. */
  nodeStaleAfterS: number;
  /** Milliseconds a two-target condition must persist before it becomes "high" (0 = immediately). */
  alertDwellMs: number;
  /** Where alarms are POSTed (signed with `alertWebhookSecret` when set); null when unused. */
  alertWebhookUrl: string | null;
  alertWebhookSecret: string;
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
  const alertWebhookSecret = env.ARMOR_ALERT_WEBHOOK_SECRET?.trim() ?? "";
  if (alertWebhookUrl && !alertWebhookSecret) warnings.push("ARMOR_ALERT_WEBHOOK_SECRET is not set; alarm calls will not be signed");
  if (alertWebhookSecret) secret(env, "ARMOR_ALERT_WEBHOOK_SECRET");

  const mqttUrl = env.ARMOR_MQTT_URL?.trim();
  return {
    host,
    port: integer(env, "ARMOR_PORT", 8080, 1, 65535),
    ingestToken, controlToken, operatorToken, cameraConfigKey,
    cameraKeyIsFallback: !configuredKey,
    studioUsername, studioPassword,
    studioSessionTtlMs: integer(env, "ARMOR_STUDIO_SESSION_TTL_MS", 28_800_000, 60_000, 7 * 86_400_000),
    operatorSessionTtlMs: integer(env, "ARMOR_OPERATOR_SESSION_TTL_MS", 28_800_000, 60_000, 7 * 86_400_000),
    studioOrigins: [...origins],
    cookieSecure: env.ARMOR_COOKIE_SECURE === "1",
    dataDir: path.resolve(env.ARMOR_DATA_DIR ?? "data"),
    ffmpegPath: env.ARMOR_FFMPEG_PATH?.trim() ?? "",
    maxMjpegRelays: integer(env, "ARMOR_MAX_MJPEG_RELAYS", 8, 1, 64),
    maxMediaBytes: integer(env, "ARMOR_MEDIA_MAX_BYTES", 20 * 1024 ** 3, 64 * 1024 ** 2, Number.MAX_SAFE_INTEGER),
    mediaRetentionMs: integer(env, "ARMOR_MEDIA_RETENTION_DAYS", 30, 0, 3650) * 86_400_000,
    discoveryCidr: cidr,
    mqtt: mqttUrl ? { url: mqttUrl, username: env.ARMOR_MQTT_USERNAME?.trim() || undefined, password: env.ARMOR_MQTT_PASSWORD || undefined } : null,
    nodeStaleAfterS: integer(env, "ARMOR_NODE_STALE_AFTER_S", 30, 5, 3600),
    alertDwellMs: integer(env, "ARMOR_ALERT_DWELL_MS", 2000, 0, 60_000),
    alertWebhookUrl, alertWebhookSecret,
    warnings,
  };
}
