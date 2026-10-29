/**
 * The security options an administrator can turn on or off from Studio, kept in `security-settings.json` with the rest of the server's data. Each has a default that is the way the
 * server always behaved (or the more careful way when the option is new and nothing depends on it), a closed list of values, and a rule about who may change it (an administrator,
 * through `/api/v1/security/settings`). Lowering one is written in the audit trail.
 *
 *   alarm.disarm_pin             never | if_set | always   the PIN typed to disarm or silence a siren (the duress PIN is never changed by this)
 *   voice.silence_confirmation   off | pin | double_turn   what the voice assistant asks before silencing the alarm (sent to the voice service with every turn)
 *   alarm.config_hash            on | off                  the panel binds its saved armed state to its zones and PIN and does not restore it if they changed (panel side)
 *   server.zone_feed             on | off                  the server tells the panels the state of their Zigbee zones
 *   server.zone_feed_signature   on | off                  every zone message is signed, so a panel can tell it came from this server
 *   media.rtsp_proxy             on | off                  FFmpeg reads the cameras through the local tunnel (off: the camera login goes in its command line, visible to every user of the machine)
 *   voice.multipart_turn         on | off                  the wall panel may send a spoken turn as multipart/form-data with the audio as raw bytes (off: only the older raw request is taken, a multipart one is answered 415)
 *   panel.live_events            on | off                  the wall panel may listen to the live channel (a WebSocket that carries the same small summary it can ask for; off: it asks every few seconds)
 *   client.device_lock           user | sensitive | always   what the phone app asks of the person with the lock of the phone itself (fingerprint, face or the phone's PIN): user = the phone's own switches decide, sensitive = also before arming, disarming and unlocking, always = also to open the app (it can only raise what a person chose, never lower it, and a phone with no lock at all is never shut out)
 *   nodes.nvs_encryption         off | secrets            the alarm nodes keep only the secrets they store (passwords, token, keys) encrypted in their flash (told in the policy message; off, the default, tells nothing)
 *   voice.turn_max_bytes         3200 to 1920000          the most audio one spoken turn of the wall panel may carry (the environment's ARMOR_VOICE_TURN_MAX_BYTES is where it starts)
 *   voice.reply_audio_max_bytes  3200 to 1000000          the most spoken answer handed on to the panel in the binary form (ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES is where it starts)
 *   alarm_audio.spoken           on | off                  the wall panel may ask for an alarm to be said out loud (origin, severity and what it is, made by the voice gateway; off, the default, answers 404)
 *   alarm_audio.custom_sounds    on | off                  administrators may upload a short sound for an alarm origin and the wall panel may ask for it (off, the default: nothing is accepted or served)
 *   network.login_secure_only    on | off                 a stored device login is handed to a network node only when its request came over TLS or from this machine (off, the default: any request of the node)
 *
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export const DISARM_PIN_VALUES = ["never", "if_set", "always"] as const;
export const SILENCE_VALUES = ["off", "pin", "double_turn"] as const;
export const DEVICE_LOCK_VALUES = ["user", "sensitive", "always"] as const;
export const NVS_ENCRYPTION_VALUES = ["off", "secrets"] as const;
export type NvsEncryption = typeof NVS_ENCRYPTION_VALUES[number];
/** The ceilings of the two sizes of a spoken turn: no value above them is taken, whatever the environment or Studio say. */
export const VOICE_TURN_BYTES = { min: 3_200, max: 1_920_000, default: 480_000 } as const;
export const VOICE_REPLY_AUDIO_BYTES = { min: 3_200, max: 1_000_000, default: 200_000 } as const;
export type DeviceLockPolicy = typeof DEVICE_LOCK_VALUES[number];
export type DisarmPinMode = typeof DISARM_PIN_VALUES[number];
export type SilenceConfirmation = typeof SILENCE_VALUES[number];

export type SecuritySettingsValues = {
  "alarm.disarm_pin": DisarmPinMode;
  "voice.silence_confirmation": SilenceConfirmation;
  "alarm.config_hash": boolean;
  "server.zone_feed": boolean;
  "server.zone_feed_signature": boolean;
  "media.rtsp_proxy": boolean;
  "network.login_secure_only": boolean;
  "voice.multipart_turn": boolean;
  "panel.live_events": boolean;
  "client.device_lock": DeviceLockPolicy;
  "nodes.nvs_encryption": NvsEncryption;
  "voice.turn_max_bytes": number;
  "voice.reply_audio_max_bytes": number;
  "alarm_audio.spoken": boolean;
  "alarm_audio.custom_sounds": boolean;
};
export type SecuritySettingKey = keyof SecuritySettingsValues;

export const SECURITY_DEFAULTS: Readonly<SecuritySettingsValues> = Object.freeze({
  "alarm.disarm_pin": "if_set",
  "voice.silence_confirmation": "off",
  "alarm.config_hash": true,
  "server.zone_feed": true,
  "server.zone_feed_signature": true,
  "media.rtsp_proxy": true,
  "network.login_secure_only": false,
  "voice.multipart_turn": true,
  "panel.live_events": true,
  "client.device_lock": "user",
  "nodes.nvs_encryption": "off",
  "voice.turn_max_bytes": VOICE_TURN_BYTES.default,
  "voice.reply_audio_max_bytes": VOICE_REPLY_AUDIO_BYTES.default,
  "alarm_audio.spoken": false,
  "alarm_audio.custom_sounds": false,
});

/** The settings that are whole numbers, with the range each may take. */
const NUMBER_RANGES: Partial<Record<keyof SecuritySettingsValues, { min: number; max: number }>> = { "voice.turn_max_bytes": VOICE_TURN_BYTES, "voice.reply_audio_max_bytes": VOICE_REPLY_AUDIO_BYTES };

export class SecuritySettingsInvalid extends Error {
  constructor(message: string, readonly key?: string) { super(message); }
}

const KEYS = Object.keys(SECURITY_DEFAULTS) as SecuritySettingKey[];
const isKey = (value: string): value is SecuritySettingKey => (KEYS as string[]).includes(value);

/** The value if it is a valid one for that setting; undefined otherwise. */
function clean(key: SecuritySettingKey, value: unknown): SecuritySettingsValues[SecuritySettingKey] | undefined {
  if (key === "alarm.disarm_pin") return (DISARM_PIN_VALUES as readonly unknown[]).includes(value) ? value as DisarmPinMode : undefined;
  if (key === "voice.silence_confirmation") return (SILENCE_VALUES as readonly unknown[]).includes(value) ? value as SilenceConfirmation : undefined;
  if (key === "nodes.nvs_encryption") return (NVS_ENCRYPTION_VALUES as readonly unknown[]).includes(value) ? value as NvsEncryption : undefined;
  if (key === "client.device_lock") return (DEVICE_LOCK_VALUES as readonly unknown[]).includes(value) ? value as DeviceLockPolicy : undefined;
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
      if (locked.has(key) && ok !== this.effective[key]) throw new SecuritySettingsInvalid(`${key} is fixed by the environment of the server`, key);
      if (next[key] !== ok) { next[key] = ok; changes[key] = ok; }
    }
    if (!Object.keys(changes).length) return {};
    for (const key of Object.keys(changes)) this.#explicit.add(key);
    this.#save(next as SecuritySettingsValues);
    this.#values = next as SecuritySettingsValues;
    this.#onChange(changes as Partial<SecuritySettingsValues>);
    return changes as Partial<SecuritySettingsValues>;
  }

  #save(values: SecuritySettingsValues): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    const written = Object.fromEntries(Object.entries(values).filter(([key]) => !(key in NUMBER_RANGES) || this.#explicit.has(key)));   // a size nobody set stays out, so the environment still decides it
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, settings: written }, null, 2), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#file);
  }
}

/** True when the new value lowers security compared with the old one (the audit trail and Studio say so). */
export function lowers(key: SecuritySettingKey, from: unknown, to: unknown): boolean {
  if (key === "voice.multipart_turn" || key === "panel.live_events" || key === "alarm_audio.spoken" || key === "alarm_audio.custom_sounds") return false;   // a way in that is turned off is not a loss of protection; turning it on is the default way
  if (key === "voice.turn_max_bytes" || key === "voice.reply_audio_max_bytes") return typeof from === "number" && typeof to === "number" && to > from;   // a larger turn costs the server more memory and time
  if (key === "alarm.disarm_pin") return DISARM_PIN_VALUES.indexOf(to as DisarmPinMode) < DISARM_PIN_VALUES.indexOf(from as DisarmPinMode);
  if (key === "voice.silence_confirmation") return SILENCE_VALUES.indexOf(to as SilenceConfirmation) < SILENCE_VALUES.indexOf(from as SilenceConfirmation);
  if (key === "nodes.nvs_encryption") return from === "secrets" && to === "off";
  if (key === "client.device_lock") return DEVICE_LOCK_VALUES.indexOf(to as DeviceLockPolicy) < DEVICE_LOCK_VALUES.indexOf(from as DeviceLockPolicy);
  return from === true && to === false;
}
