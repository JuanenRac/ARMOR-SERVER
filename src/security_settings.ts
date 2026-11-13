/**
 * The security options an administrator can turn on or off from Studio, kept in `security-settings.json` with the rest of the server's data. Each has a default that is the way the
 * server always behaved (or the more careful way when the option is new and nothing depends on it), a closed list of values, and a rule about who may change it (an administrator,
 * through `/api/v1/security/settings`). Lowering one is written in the audit trail.
 *
 *   alarm.disarm_pin             never | if_set | always   the PIN typed to disarm or silence a siren (the duress PIN is never changed by this)
 *   alarm.arming_modes           on | off                  the arming modes home and night besides away (off, the default: the system only arms and disarms, as it always did)
 *   alarm.mode_downgrade_pin     required | not_required   going to a mode that defends LESS than the current one asks for the PIN like a disarm (required, the default)
 *   alarm.mode_schedule          on | off                  the timetable of the arming modes changes the mode by itself (off, the default; it needs alarm.arming_modes)
 *   alarm.mode_schedule_lowers   on | off                  the timetable may go to a mode that defends less (off, the default: it only keeps or raises the defence, it can never disarm)
 *   alarm.mode_panel_sync        on | off                  choosing away, home or night also arms the alarm panels with the profile that goes with it (off, the default: the modes decide only what the server defends; it needs alarm.arming_modes)
 *   voice.silence_confirmation   off | pin | double_turn | challenge   what the voice assistant asks before silencing the alarm (sent to the voice service with every turn). challenge = a number the voice service draws, shown on the screen of the panel and never said aloud: only a panel that shows it can silence by voice, every other client (Studio, the phone) fails closed
 *   alarm.config_hash            on | off                  the panel binds its saved armed state to its zones and PIN and does not restore it if they changed (panel side)
 *   alarm.siren_fault_notice     on | off                  a warning in the alarm centre while a panel reports that the wiring of its siren is open, shorted or unreadable (on, the default; off: nothing is raised)
 *   server.zone_feed             on | off                  the server tells the panels the state of their Zigbee zones
 *   server.zone_feed_signature   on | off                  every zone message is signed, so a panel can tell it came from this server
 *   server.alarm_state_signature on | off                  the server publishes a signed copy of each alarm state it hears, so a reader on the broker (the safety zones of a HYDRA-UMC cell) can tell who sent it (off, the default)
 *   media.rtsp_proxy             on | off                  FFmpeg reads the cameras through the local tunnel (off: the camera login goes in its command line, visible to every user of the machine)
 *   voice.panic_phrase           on | off                  a user's secret panic phrase, said to the voice assistant, raises the silent duress alarm (off, the default: nobody's phrase is looked for)
 *   voice.panic_cooldown_s      10 to 3600               after a panic phrase, the seconds in which the same user's phrase raises nothing more (60)
 *   voice.multipart_turn         on | off                  the wall panel may send a spoken turn as multipart/form-data with the audio as raw bytes (off: only the older raw request is taken, a multipart one is answered 415)
 *   voice.wake_word             on | off                  the wall panel may send short chunks of audio to the voice gateway to hear its wake word (openWakeWord, on this machine, no cloud); off, the default: the route answers 403 and no audio is passed on
 *   admin.acl_relays             on | off                  Studio may ask the admin agent to open or close the two switches of the broker rules that no install turns on (the writing to the batteries of one solar node, and the signed copy of the alarm states); off, the default: the routes answer 403, and each change also needs the code of the authenticator and two confirmations
 *   admin.field_http             on | off                  Studio may ask the admin agent to let the field network also reach the server's port over HTTP (the firewall switch field-http); off, the default: the routes answer 403, and each change also needs the code of the authenticator and a confirmation
 *   panel.live_events            on | off                  the wall panel may listen to the live channel (a WebSocket that carries the same small summary it can ask for; off: it asks every few seconds)
 *   client.device_lock           user | sensitive | always   what the phone app asks of the person with the lock of the phone itself (fingerprint, face or the phone's PIN): user = the phone's own switches decide, sensitive = also before arming, disarming and unlocking, always = also to open the app (it can only raise what a person chose, never lower it, and a phone with no lock at all is never shut out)
 *   client.trusted_devices       on | off                  a phone may be registered as a trusted device (a key pair that stays in the phone) and renew its session by signing a one-time challenge instead of typing the password and the code again (off, the default: nothing is registered or accepted)
 *   client.trusted_session_h     1 to 720                 how long the session handed to a trusted phone lasts, in hours (72)
 *   nodes.nvs_encryption         off | secrets            the alarm nodes keep only the secrets they store (passwords, token, keys) encrypted in their flash (told in the policy message; off, the default, tells nothing)
 *   voice.turn_max_bytes         3200 to 1920000          the most audio one spoken turn of the wall panel may carry (the environment's ARMOR_VOICE_TURN_MAX_BYTES is where it starts)
 *   voice.reply_audio_max_bytes  3200 to 1000000          the most spoken answer handed on to the panel in the binary form (ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES is where it starts)
 *   alarm_audio.spoken           on | off                  the wall panel may ask for an alarm to be said out loud (origin, severity and what it is, made by the voice gateway; off, the default, answers 404)
 *   alarm_audio.custom_sounds    on | off                  administrators may upload a short sound for an alarm origin and the wall panel may ask for it (off, the default: nothing is accepted or served)
 *   electrical.set_aside_old_readings  on | off   a channel of an electrical node whose own reading is old (its meter stopped answering and the node repeats the last good numbers) is left out of the grid figure and the graphs and marked as having no data (on, the default; off: the numbers are taken as the node sends them)
 *   login.country_alert          on | off                 a sign-in from outside the house from a country that person never signed in from before is told to the places the alarms go to (on, the default; it only acts when the server has a country database, ARMOR_GEOIP_DB)
 *   summary.daily                on | off                 administrators and operators may ask for the summary of a day (GET /api/v1/summary/daily, made by ARMOR-SERVER-AI from the alarms the server kept; off, the default, answers 404)
 *   vision.heatmap               on | off                 administrators and operators may ask for the activity heat map of a camera (GET /api/v1/vision/heatmap, made by ARMOR-VISION; positions only, never a picture; off, the default, answers 404)
 *   vision.activity_events       on | off                 the server takes the activity events of ARMOR-VISION (POST /api/v1/ai/activity-events: every event is recorded, and an alert zone may raise an alarm unless the profile of the mode says not to tell; off, the default, answers { raised: false, reason: feature_off } and records nothing)
 *   vision.service_url           an http address            where the live ARMOR-VISION service listens (http://127.0.0.1:8765): the heat map is asked of it (ARMOR_VISION_SERVICE_URL is where it starts; empty: not set up)
 *   vision.service_token_set     on | off (read only)     whether the server holds a token for the vision service (ARMOR_VISION_SERVICE_TOKEN or ARMOR_VISION_SERVICE_TOKEN_FILE); the token itself is never shown or stored here
 *   vision.service_remote        on | off                   the service may be on another machine (off, the default: only a loopback address is used)
 *   media.retention_snapshot_days / media.retention_recording_days   0 to 3650   how many days snapshots and recordings are kept, each kind on its own (0: the general limit ARMOR_MEDIA_RETENTION_DAYS applies; the environment variables ARMOR_MEDIA_RETENTION_SNAPSHOT_DAYS and _RECORDING_DAYS are where they start)
 *   summary.log_days             1 to 90                  the days the daily log keeps (the readings and the power the summary of a day uses; ARMOR_DAILY_LOG_DAYS is where it starts; 14)
 *   summary.reading_every_s      10 to 3600               the most often a reading of one sensor is logged (ARMOR_DAILY_LOG_READING_EVERY_S; 300)
 *   summary.power_every_s        5 to 3600                the most often the power of the house is logged (ARMOR_DAILY_LOG_POWER_EVERY_S; 60)
 *   summary.false_alarm_s        0 to 600                 an intrusion alarm that a disarm ends within this many seconds counts as a false alarm in the summary (0: none is inferred; ARMOR_DAILY_FALSE_ALARM_S; 60)
 *   reports.timeout_s            5 to 120                 the most seconds one summary or heat map may run (ARMOR_REPORT_TIMEOUT_S is where it starts; 20)
 *   reports.queue_max            1 to 10                  how many reports may wait for their turn before the answer is "busy" (ARMOR_REPORT_QUEUE_MAX; 3)
 *   reports.requests_per_minute  1 to 300                 how many requests a minute the two report routes answer (ARMOR_REPORT_REQUESTS_PER_MINUTE; 30)
 *   metrics.prometheus           on | off                 GET /metrics answers the numbers of the server in the Prometheus text form to the bearer token ARMOR_METRICS_TOKEN (off, the default, answers 404; with no token set it answers 404 too)
 *   heartbeat.enabled            on | off                 the server asks the address ARMOR_HEARTBEAT_URL every ARMOR_HEARTBEAT_INTERVAL_S seconds, so a service outside the house can tell the owner when the pings stop (off, the default)
 *   ingest.recording             on | off                 the server keeps a copy of what the nodes send (and why a message was refused) in a JSON-lines file the simulator can play again, with a size limit and rotation from ARMOR_INGEST_RECORD_MAX_BYTES and ARMOR_INGEST_RECORD_FILES (off, the default: nothing is written)
 *   network.lan_ca              on | off                 an administrator may download the public certificate of the local CA that signs the HTTPS certificate of the LAN (GET /api/v1/security/lan-ca; the private key is never served; off, the default, answers 404)
 *   vision.semantic_search / vision.plates / vision.faces   on | off   the three features of the second phase of ARMOR-VISION that read personal data (search by meaning, licence plates, faces); each is off by default and cannot be turned on until its acknowledgement setting (the same name plus _ack) says the privacy notice was read
 *   network.public_access       on | off                 requests from outside the house and the VPN are taken at all, and only over TLS with strong secrets (off, the default: every one is answered 403 public_access_off; see public_access.ts)
 *   network.login_secure_only    on | off                 a stored device login is handed to a network node only when its request came over TLS or from this machine (off, the default: any request of the node)
 *
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export const DISARM_PIN_VALUES = ["never", "if_set", "always"] as const;
export const MODE_DOWNGRADE_VALUES = ["required", "not_required"] as const;
export type ModeDowngradePin = typeof MODE_DOWNGRADE_VALUES[number];
export const SILENCE_VALUES = ["off", "pin", "double_turn", "challenge"] as const;   // from the loosest to the strictest: the loosening check reads the order
export const DEVICE_LOCK_VALUES = ["user", "sensitive", "always"] as const;
export const NVS_ENCRYPTION_VALUES = ["off", "secrets"] as const;
export type NvsEncryption = typeof NVS_ENCRYPTION_VALUES[number];
/** The ceilings of the two sizes of a spoken turn: no value above them is taken, whatever the environment or Studio say. */
export const VOICE_TURN_BYTES = { min: 3_200, max: 1_920_000, default: 480_000 } as const;
/** The quiet time after a panic phrase: the same user's phrase raises nothing more inside it, so a repeated or looped phrase cannot flood the people it warns. */
export const VOICE_PANIC_COOLDOWN_S = { min: 10, max: 3600, default: 60 } as const;
export const VOICE_REPLY_AUDIO_BYTES = { min: 3_200, max: 1_000_000, default: 200_000 } as const;
/** The limits of the two reports (the summary of a day and the heat map): how long one may run, how many may wait for their turn, and how many requests a minute are answered. */
/** The address of the live service of ARMOR-VISION: an origin (scheme, host, optional port) and nothing else, at most 100 characters, no sign-in in it. "" is "not set up". */
export const VISION_SERVICE_URL_MAX = 100;
export function parseVisionServiceUrl(value: unknown): { origin: string; host: string } | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > VISION_SERVICE_URL_MAX || /\s/.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || !url.hostname) return undefined;
  if (/[?#]$/.test(value)) return undefined;
  return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, "") };
}
/** Whether a host is this machine: localhost or a loopback address. */
export const isLoopbackHost = (host: string): boolean => host === "localhost" || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1";
/** A token that would go in clear to another machine: the service is allowed to be remote, the server holds a token for it and the address is plain http on a host that is not this machine. */
export function visionTokenInClear(remote: boolean, tokenHeld: boolean, url: string): boolean {
  if (!remote || !tokenHeld) return false;
  const service = parseVisionServiceUrl(url);
  return service !== undefined && service.origin.startsWith("http:") && !isLoopbackHost(service.host);
}
/** How long the session of a trusted phone lasts, in hours. */
export const TRUSTED_SESSION_H = { min: 1, max: 720, default: 72 } as const;
/** How many days a snapshot and a recording are kept; 0 means the general limit (ARMOR_MEDIA_RETENTION_DAYS) applies. */
export const MEDIA_RETENTION_DAYS = { min: 0, max: 3650, default: 0 } as const;
export const SUMMARY_LOG_DAYS = { min: 1, max: 90, default: 14 } as const;
export const SUMMARY_READING_EVERY_S = { min: 10, max: 3600, default: 300 } as const;
export const SUMMARY_POWER_EVERY_S = { min: 5, max: 3600, default: 60 } as const;
export const SUMMARY_FALSE_ALARM_S = { min: 0, max: 600, default: 60 } as const;
export const REPORT_TIMEOUT_S = { min: 5, max: 120, default: 20 } as const;
export const REPORT_QUEUE_MAX = { min: 1, max: 10, default: 3 } as const;
export const REPORT_REQUESTS_PER_MINUTE = { min: 1, max: 300, default: 30 } as const;
export type DeviceLockPolicy = typeof DEVICE_LOCK_VALUES[number];
export type DisarmPinMode = typeof DISARM_PIN_VALUES[number];
export type SilenceConfirmation = typeof SILENCE_VALUES[number];

export type SecuritySettingsValues = {
  "alarm.disarm_pin": DisarmPinMode;
  "voice.silence_confirmation": SilenceConfirmation;
  "alarm.arming_modes": boolean;
  "alarm.mode_downgrade_pin": ModeDowngradePin;
  "alarm.mode_schedule": boolean;
  "alarm.mode_schedule_lowers": boolean;
  "alarm.mode_panel_sync": boolean;
  "alarm.config_hash": boolean;
  "alarm.siren_fault_notice": boolean;
  "server.zone_feed": boolean;
  "server.zone_feed_signature": boolean;
  "server.alarm_state_signature": boolean;
  "media.rtsp_proxy": boolean;
  "network.login_secure_only": boolean;
  "network.lan_ca": boolean;
  "network.public_access": boolean;
  "media.retention_snapshot_days": number;
  "media.retention_recording_days": number;
  "vision.semantic_search": boolean;
  "vision.plates": boolean;
  "vision.faces": boolean;
  "vision.semantic_search_ack": boolean;
  "vision.plates_ack": boolean;
  "vision.faces_ack": boolean;
  "metrics.prometheus": boolean;
  "heartbeat.enabled": boolean;
  "ingest.recording": boolean;
  "login.country_alert": boolean;
  "electrical.set_aside_old_readings": boolean;
  "voice.multipart_turn": boolean;
  "voice.wake_word": boolean;
  "voice.panic_phrase": boolean;
  "voice.panic_cooldown_s": number;
  "admin.acl_relays": boolean;
  "admin.field_http": boolean;
  "panel.live_events": boolean;
  "client.device_lock": DeviceLockPolicy;
  "client.trusted_devices": boolean;
  "client.trusted_session_h": number;
  "nodes.nvs_encryption": NvsEncryption;
  "voice.turn_max_bytes": number;
  "voice.reply_audio_max_bytes": number;
  "alarm_audio.spoken": boolean;
  "alarm_audio.custom_sounds": boolean;
  "summary.daily": boolean;
  "vision.heatmap": boolean;
  "vision.activity_events": boolean;
  "vision.service_url": string;
  "vision.service_remote": boolean;
  "vision.service_token_set": boolean;
  "summary.log_days": number;
  "summary.reading_every_s": number;
  "summary.power_every_s": number;
  "summary.false_alarm_s": number;
  "reports.timeout_s": number;
  "reports.queue_max": number;
  "reports.requests_per_minute": number;
};
export type SecuritySettingKey = keyof SecuritySettingsValues;

export const SECURITY_DEFAULTS: Readonly<SecuritySettingsValues> = Object.freeze({
  "alarm.disarm_pin": "if_set",
  "voice.silence_confirmation": "off",
  "alarm.arming_modes": false,
  "alarm.mode_downgrade_pin": "required",
  "alarm.mode_schedule": false,
  "alarm.mode_schedule_lowers": false,
  "alarm.mode_panel_sync": false,
  "alarm.config_hash": true,
  "alarm.siren_fault_notice": true,
  "server.zone_feed": true,
  "server.zone_feed_signature": true,
  "server.alarm_state_signature": false,
  "media.rtsp_proxy": true,
  "network.login_secure_only": false,
  "network.lan_ca": false,
  "network.public_access": false,
  "media.retention_snapshot_days": MEDIA_RETENTION_DAYS.default,
  "media.retention_recording_days": MEDIA_RETENTION_DAYS.default,
  "vision.semantic_search": false,
  "vision.plates": false,
  "vision.faces": false,
  "vision.semantic_search_ack": false,
  "vision.plates_ack": false,
  "vision.faces_ack": false,
  "metrics.prometheus": false,
  "heartbeat.enabled": false,
  "ingest.recording": false,
  "login.country_alert": true,
  "electrical.set_aside_old_readings": true,
  "voice.multipart_turn": true,
  "voice.wake_word": false,
  "voice.panic_phrase": false,
  "voice.panic_cooldown_s": VOICE_PANIC_COOLDOWN_S.default,
  "admin.acl_relays": false,
  "admin.field_http": false,
  "panel.live_events": true,
  "client.device_lock": "user",
  "client.trusted_devices": false,
  "client.trusted_session_h": TRUSTED_SESSION_H.default,
  "nodes.nvs_encryption": "off",
  "voice.turn_max_bytes": VOICE_TURN_BYTES.default,
  "voice.reply_audio_max_bytes": VOICE_REPLY_AUDIO_BYTES.default,
  "alarm_audio.spoken": false,
  "alarm_audio.custom_sounds": false,
  "summary.daily": false,
  "vision.heatmap": false,
  "vision.activity_events": false,
  "vision.service_url": "",
  "vision.service_remote": false,
  "vision.service_token_set": false,
  "summary.log_days": SUMMARY_LOG_DAYS.default,
  "summary.reading_every_s": SUMMARY_READING_EVERY_S.default,
  "summary.power_every_s": SUMMARY_POWER_EVERY_S.default,
  "summary.false_alarm_s": SUMMARY_FALSE_ALARM_S.default,
  "reports.timeout_s": REPORT_TIMEOUT_S.default,
  "reports.queue_max": REPORT_QUEUE_MAX.default,
  "reports.requests_per_minute": REPORT_REQUESTS_PER_MINUTE.default,
});

/** The settings that are whole numbers, with the range each may take. */
const NUMBER_RANGES: Partial<Record<keyof SecuritySettingsValues, { min: number; max: number }>> = { "voice.turn_max_bytes": VOICE_TURN_BYTES, "voice.reply_audio_max_bytes": VOICE_REPLY_AUDIO_BYTES, "voice.panic_cooldown_s": VOICE_PANIC_COOLDOWN_S, "client.trusted_session_h": TRUSTED_SESSION_H,
  "summary.log_days": SUMMARY_LOG_DAYS, "summary.reading_every_s": SUMMARY_READING_EVERY_S, "summary.power_every_s": SUMMARY_POWER_EVERY_S, "summary.false_alarm_s": SUMMARY_FALSE_ALARM_S,
  "media.retention_snapshot_days": MEDIA_RETENTION_DAYS, "media.retention_recording_days": MEDIA_RETENTION_DAYS, "reports.timeout_s": REPORT_TIMEOUT_S, "reports.queue_max": REPORT_QUEUE_MAX, "reports.requests_per_minute": REPORT_REQUESTS_PER_MINUTE };

/** The features of the second phase of the vision service that read personal data: each has a switch and an acknowledgement of its privacy notice. */
export const VISION_PERSONAL_FEATURES = ["semantic_search", "plates", "faces"] as const;

export class SecuritySettingsInvalid extends Error {
  constructor(message: string, readonly key?: string) { super(message); }
}

const KEYS = Object.keys(SECURITY_DEFAULTS) as SecuritySettingKey[];
const isKey = (value: string): value is SecuritySettingKey => (KEYS as string[]).includes(value);

/** The value if it is a valid one for that setting; undefined otherwise. */
function clean(key: SecuritySettingKey, value: unknown): SecuritySettingsValues[SecuritySettingKey] | undefined {
  if (key === "alarm.disarm_pin") return (DISARM_PIN_VALUES as readonly unknown[]).includes(value) ? value as DisarmPinMode : undefined;
  if (key === "alarm.mode_downgrade_pin") return (MODE_DOWNGRADE_VALUES as readonly unknown[]).includes(value) ? value as ModeDowngradePin : undefined;
  if (key === "voice.silence_confirmation") return (SILENCE_VALUES as readonly unknown[]).includes(value) ? value as SilenceConfirmation : undefined;
  if (key === "nodes.nvs_encryption") return (NVS_ENCRYPTION_VALUES as readonly unknown[]).includes(value) ? value as NvsEncryption : undefined;
  if (key === "client.device_lock") return (DEVICE_LOCK_VALUES as readonly unknown[]).includes(value) ? value as DeviceLockPolicy : undefined;
  if (key === "vision.service_url") return value === "" || parseVisionServiceUrl(value) !== undefined ? value as string : undefined;
  const range = NUMBER_RANGES[key];
  if (range) return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max ? value : undefined;
  return typeof value === "boolean" ? value : undefined;
}

export class SecuritySettings {
  #values: SecuritySettingsValues = { ...SECURITY_DEFAULTS };
  /** The sizes that were set in Studio: the others follow the environment (where they start) until someone sets them. */
  readonly #explicit = new Set<string>();
  readonly #file: string;
  readonly #lockedByEnvironment: () => Partial<Record<SecuritySettingKey, unknown>>;
  readonly #onChange: (changes: Partial<SecuritySettingsValues>) => void;

  /** `environment` gives the values the environment fixes (they win over the stored ones); `onChange` is told after every change. */
  constructor(file: string, options: { environment?: () => Partial<Record<SecuritySettingKey, unknown>>; onChange?: (changes: Partial<SecuritySettingsValues>) => void; initial?: Partial<SecuritySettingsValues> } = {}) {
    this.#file = file;
    // where the sizes start when nobody has set them: the environment of the server (checked like a value from Studio, so one out of range keeps the default)
    for (const [key, value] of Object.entries(options.initial ?? {})) if (isKey(key) && clean(key, value) !== undefined) (this.#values as Record<string, unknown>)[key] = value;
    this.#lockedByEnvironment = options.environment ?? (() => ({}));
    this.#onChange = options.onChange ?? (() => undefined);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { settings?: Record<string, unknown> };
      for (const [key, value] of Object.entries(raw?.settings ?? {})) {
        if (!isKey(key)) continue;
        const ok = clean(key, value);
        if (ok !== undefined) { (this.#values as Record<string, unknown>)[key] = ok; this.#explicit.add(key); }   // a value that is not valid keeps the default
      }
    } catch { /* no file, or one that cannot be read: the defaults */ }
  }

  /** What is in force: the stored values, except those the environment fixes. */
  get effective(): SecuritySettingsValues {
    const out = { ...this.#values } as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.#lockedByEnvironment())) if (isKey(key) && value !== undefined) out[key] = value;
    return out as SecuritySettingsValues;
  }

  get stored(): SecuritySettingsValues { return { ...this.#values }; }

  /** The settings the environment fixes: Studio shows them and cannot change them. */
  get lockedKeys(): SecuritySettingKey[] { return Object.entries(this.#lockedByEnvironment()).filter(([, value]) => value !== undefined).map(([key]) => key as SecuritySettingKey); }

  get<K extends SecuritySettingKey>(key: K): SecuritySettingsValues[K] { return this.effective[key]; }

  /** Applies the given settings (a partial object); throws SecuritySettingsInvalid on an unknown name or a bad value, changing nothing. Returns the ones that changed. */
  update(patch: unknown): Partial<SecuritySettingsValues> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new SecuritySettingsInvalid("the settings are an object");
    const next = { ...this.#values } as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    const locked = new Set(this.lockedKeys as string[]);
    for (const [key, value] of Object.entries(patch)) {
      if (!isKey(key)) throw new SecuritySettingsInvalid(`unknown setting ${key.slice(0, 60)}`, key.slice(0, 60));
      const ok = clean(key, value);
      if (ok === undefined) throw new SecuritySettingsInvalid(`invalid value for ${key}`, key);
      if (key === "vision.service_token_set" && ok !== this.effective[key]) throw new SecuritySettingsInvalid(`${key} is read only: the token is given in the environment of the server`, key);
      if (locked.has(key) && ok !== this.effective[key]) throw new SecuritySettingsInvalid(`${key} is fixed by the environment of the server`, key);
      if (next[key] !== ok) { next[key] = ok; changes[key] = ok; }
    }
    if (!Object.keys(changes).length) return {};
    // a token travels with every request to the vision service: away from this machine it must not go in clear
    const after = { ...next } as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.#lockedByEnvironment())) if (isKey(key) && value !== undefined) after[key] = value;
    if (visionTokenInClear(after["vision.service_remote"] === true, after["vision.service_token_set"] === true, String(after["vision.service_url"] ?? ""))) {
      throw new SecuritySettingsInvalid("vision.service_url must be https when vision.service_remote is on and the server holds a token for the service: the token would travel in clear", "vision.service_url");
    }
    // a feature that reads personal data cannot be on unless the privacy notice was acknowledged
    for (const feature of VISION_PERSONAL_FEATURES) {
      if (after[`vision.${feature}`] === true && after[`vision.${feature}_ack`] !== true) throw new SecuritySettingsInvalid(`vision.${feature} needs vision.${feature}_ack: read the privacy notice first`, `vision.${feature}`);
    }
    for (const key of Object.keys(changes)) this.#explicit.add(key);
    this.#save(next as SecuritySettingsValues);
    this.#values = next as SecuritySettingsValues;
    this.#onChange(changes as Partial<SecuritySettingsValues>);
    return changes as Partial<SecuritySettingsValues>;
  }

  #save(values: SecuritySettingsValues): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    const written = Object.fromEntries(Object.entries(values).filter(([key]) => !(key in NUMBER_RANGES || key === "vision.service_url") || this.#explicit.has(key)));   // a size nobody set stays out, so the environment still decides it
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, settings: written }, null, 2), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#file);
  }
}

/** True when the new value lowers security compared with the old one (the audit trail and Studio say so). */
export function lowers(key: SecuritySettingKey, from: unknown, to: unknown): boolean {
  if (key === "voice.multipart_turn" || key === "panel.live_events" || key === "alarm_audio.spoken" || key === "alarm_audio.custom_sounds") return false;   // a way in that is turned off is not a loss of protection; turning it on is the default way
  if (key === "summary.log_days" || key === "summary.reading_every_s" || key === "summary.power_every_s" || key === "summary.false_alarm_s") return false;   // what the summary of a day is made from: tuning, not a protection
  if (key === "media.retention_snapshot_days" || key === "media.retention_recording_days") return false;   // how long evidence is kept: tuning, not a protection
  if (key === "voice.panic_cooldown_s") return false;   // how long one trigger keeps quiet: tuning, not a protection
  if (key === "reports.timeout_s" || key === "reports.queue_max" || key === "reports.requests_per_minute") return false;   // tuning of how much work the reports may cause, not a protection
  if (key === "voice.wake_word") return from === false && to === true;   // a panel that listens for its word all the time is the loss, even if the audio never leaves the house
  if (key === "admin.field_http") return from === false && to === true;   // letting Studio open the server's port to the field network is the loss
  if (key === "admin.acl_relays") return from === false && to === true;   // letting Studio open the broker for the batteries or the alarm copy is the loss
  if (key === "vision.service_remote") return from === false && to === true;   // a service on another machine: the positions of the house travel over a network
  if (key === "vision.service_url") { const host = parseVisionServiceUrl(to)?.host; return host !== undefined && !isLoopbackHost(host) && to !== from; }   // pointing at another machine is the loss
  if (key === "network.lan_ca" || key === "network.public_access" || key === "vision.semantic_search" || key === "vision.plates" || key === "vision.faces") return from === false && to === true;   // a CA to trust on the phones, or a feature that reads personal data: turning it on is the loss
  if (key === "vision.semantic_search_ack" || key === "vision.plates_ack" || key === "vision.faces_ack") return false;   // reading a notice is not a loss of protection
  if (key === "summary.daily" || key === "vision.heatmap" || key === "metrics.prometheus" || key === "ingest.recording") return from === false && to === true;   // a report about what happens in the house is a way in for whoever may ask: turning it on is the loss
  if (key === "vision.activity_events") return false;   // a source of alarms that is added: what is armed is not defended less by it
  if (key === "alarm.arming_modes" || key === "alarm.mode_schedule" || key === "alarm.mode_panel_sync") return false;   // a way of arming that is added or taken away: the protection of what is armed does not drop by it
  if (key === "alarm.mode_schedule_lowers") return from === false && to === true;   // letting a timetable defend less is the loss
  if (key === "alarm.mode_downgrade_pin") return from === "required" && to === "not_required";
  if (key === "voice.turn_max_bytes" || key === "voice.reply_audio_max_bytes") return typeof from === "number" && typeof to === "number" && to > from;   // a larger turn costs the server more memory and time
  if (key === "alarm.disarm_pin") return DISARM_PIN_VALUES.indexOf(to as DisarmPinMode) < DISARM_PIN_VALUES.indexOf(from as DisarmPinMode);
  if (key === "voice.silence_confirmation") return SILENCE_VALUES.indexOf(to as SilenceConfirmation) < SILENCE_VALUES.indexOf(from as SilenceConfirmation);
  if (key === "nodes.nvs_encryption") return from === "secrets" && to === "off";
  if (key === "client.device_lock") return DEVICE_LOCK_VALUES.indexOf(to as DeviceLockPolicy) < DEVICE_LOCK_VALUES.indexOf(from as DeviceLockPolicy);
  return from === true && to === false;
}
