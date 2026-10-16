/**
 * What the server keeps when a camera sees something while the perimeter is armed: a photo (or several, a few seconds apart) and a video of a few seconds, so that the evidence is
 * there before anybody looks at the alarm. An administrator sets it (in Studio, Configuration > Video): whether it is on, whether it takes photos and how many and how far apart,
 * whether it records and for how long, and how long a camera is left alone after one capture so that a person walking in front of it does not fill the disk. It only ever uses
 * the evidence library's own snapshot and recording (the same ones a person starts by hand), it is told by the observation route and nothing else, and what it does not manage to
 * take is audited, never raised as an alarm of its own.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { AuditLog } from "./audit.js";
import type { CameraConnection } from "./cameras/model.js";
import { durableRename } from "./durable.js";

export class CaptureSettingsInvalid extends Error {}

export type CaptureSettings = {
  enabled: boolean;
  /** Take photos when something is seen. */
  photo: boolean;
  /** How many photos (the first at once), 1 to 60. */
  photo_count: number;
  /** Seconds between one photo and the next, 1 to 300. */
  photo_interval_s: number;
  /** Record a video when something is seen. */
  video: boolean;
  /** Seconds of video, 3 to 300. */
  video_seconds: number;
  /** Seconds a camera is left alone after a capture, 5 to 3600. */
  cooldown_s: number;
};

export const DEFAULT_CAPTURE: CaptureSettings = { enabled: true, photo: true, photo_count: 1, photo_interval_s: 2, video: true, video_seconds: 15, cooldown_s: 30 };
const LIMITS = { photo_count: [1, 60], photo_interval_s: [1, 300], video_seconds: [3, 300], cooldown_s: [5, 3600] } as const;

export function parseCaptureSettings(value: unknown): CaptureSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CaptureSettingsInvalid("the settings must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in DEFAULT_CAPTURE)) throw new CaptureSettingsInvalid(`unknown setting ${key}`);
  const out: CaptureSettings = { ...DEFAULT_CAPTURE };
  for (const key of ["enabled", "photo", "video"] as const) {
    if (key in input) { if (typeof input[key] !== "boolean") throw new CaptureSettingsInvalid(`${key} must be true or false`); out[key] = input[key] as boolean; }
  }
  for (const key of ["photo_count", "photo_interval_s", "video_seconds", "cooldown_s"] as const) {
    if (!(key in input)) continue;
    const number = input[key];
    const [low, high] = LIMITS[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) throw new CaptureSettingsInvalid(`${key} must be a whole number from ${low} to ${high}`);
    out[key] = number;
  }
  return out;
}

export type CaptureTools = {
  snapshot: (camera: CameraConnection) => Promise<{ id: string }>;
  startRecording: (camera: CameraConnection) => Promise<unknown>;
  stopRecording: (cameraId: string) => Promise<{ id: string }>;
  isRecording: (cameraId: string) => boolean;
};

export type CaptureOptions = {
  file: string;
  tools: CaptureTools;
  audit: AuditLog;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** A pause, in milliseconds (injectable so that the tests do not wait). */
  sleep?: (ms: number) => Promise<void>;
};

export type CaptureRecord = { camera_id: string; at: string; photos: number; video: boolean };

export class CaptureOnDetect {
  #settings: CaptureSettings = { ...DEFAULT_CAPTURE };
  readonly #lastAt = new Map<string, number>();
  readonly #busy = new Set<string>();
  readonly #recent: CaptureRecord[] = [];
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CaptureOptions) {
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }));
    try { this.#settings = parseCaptureSettings(JSON.parse(fs.readFileSync(options.file, "utf8"))); } catch { this.#settings = { ...DEFAULT_CAPTURE }; }
  }

  get(): CaptureSettings { return { ...this.#settings }; }

  set(value: unknown): CaptureSettings {
    const settings = parseCaptureSettings(value);
    const temporary = `${this.options.file}.tmp`;
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    durableRename(temporary, this.options.file);
    this.#settings = settings;
    return this.get();
  }

  recent(): CaptureRecord[] { return this.#recent.map(item => ({ ...item })); }

  /**
   * A camera saw something while the perimeter is armed. Returns what was done (nothing when it is off, when the camera is in its cooldown or when it is already being captured);
   * the photos and the video go on after it returns only as far as `await` of the result: callers that must not wait do not await it.
   */
  async trigger(camera: CameraConnection): Promise<CaptureRecord | null> {
    const settings = this.#settings;
    if (!settings.enabled || (!settings.photo && !settings.video)) return null;
    const now = this.#now();
    const last = this.#lastAt.get(camera.id);
    if (this.#busy.has(camera.id) || (last !== undefined && now - last < settings.cooldown_s * 1000)) return null;
    this.#busy.add(camera.id);
    this.#lastAt.set(camera.id, now);
    const record: CaptureRecord = { camera_id: camera.id, at: new Date(now).toISOString(), photos: 0, video: false };
    try {
      const recording = settings.video && !this.options.tools.isRecording(camera.id) ? this.#record(camera, settings.video_seconds).then(done => { record.video = done; }) : Promise.resolve();
      const photos = settings.photo ? this.#photos(camera, settings).then(count => { record.photos = count; }) : Promise.resolve();
      await Promise.all([recording, photos]);
    } finally { this.#busy.delete(camera.id); }
    this.#recent.unshift(record);
    this.#recent.length = Math.min(this.#recent.length, 20);
    this.options.audit.record({ action: "evidence.auto_capture", outcome: record.photos > 0 || record.video ? "allowed" : "failed", target: camera.id, detail: `${record.photos} photo(s)${record.video ? ", video" : ""}` });
    return record;
  }

  async #photos(camera: CameraConnection, settings: CaptureSettings): Promise<number> {
    let taken = 0;
    for (let index = 0; index < settings.photo_count; index += 1) {
      if (index > 0) await this.#sleep(settings.photo_interval_s * 1000);
      try { await this.options.tools.snapshot(camera); taken += 1; } catch { /* a photo that fails is skipped: the next one may work */ }
    }
    return taken;
  }

  async #record(camera: CameraConnection, seconds: number): Promise<boolean> {
    try { await this.options.tools.startRecording(camera); } catch { return false; }
    await this.#sleep(seconds * 1000);
    try { await this.options.tools.stopRecording(camera.id); return true; } catch { return false; }
  }
}
