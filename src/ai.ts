/**
 * What ARMOR-SERVER-AI (the observation service) is allowed to ask of this server, and how it reports back. It gets its own token (ARMOR_AI_TOKEN), which opens only three
 * routes - the context (the mode, the radar nodes and their tracks and light, the cameras), one tiny grey frame of a camera, and its observations - and nothing else:
 * it cannot arm, disarm, read the evidence or change anything. A frame is 64 x 36 grey pixels taken straight from the camera's stream (its lighter sub-stream when it has
 * one), never stored; an observation raises an alarm only while the system is armed.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { execFile } from "node:child_process";
import type { CameraConnection } from "./cameras/model.js";
import { openRtspTunnel } from "./cameras/rtsp_tunnel.js";

export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 36;
export const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT;

export class AiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Runs a program and gives back what it wrote on its standard output. */
export type RunProgram = (program: string, args: string[], timeoutMs: number) => Promise<Buffer>;

const runProgram: RunProgram = (program, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(program, args, { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export class AiGateway {
  readonly #ffmpegPath: string;
  readonly #run: RunProgram;
  readonly #proxy: () => boolean;

  constructor(options: { ffmpegPath: string; run?: RunProgram; proxy?: () => boolean }) {
    this.#proxy = options.proxy ?? (() => true);
    this.#ffmpegPath = options.ffmpegPath;
    this.#run = options.run ?? runProgram;
  }

  /** One grey frame (FRAME_WIDTH x FRAME_HEIGHT bytes) of a camera. */
  async frame(camera: CameraConnection): Promise<Buffer> {
    if (!this.#ffmpegPath) throw new AiError(503, "ffmpeg_not_configured");
    const tunnel = await openRtspTunnel(camera, { preview: true, direct: !this.#proxy() }).catch(() => null);
    if (!tunnel) throw new AiError(422, "camera_has_no_stream");
    try {
      const raw = await this.#run(this.#ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", tunnel.url,
        "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`, "-f", "rawvideo", "pipe:1",
      ], 12_000);
      if (raw.length !== FRAME_BYTES) throw new AiError(502, "bad_frame");
      return raw;
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError(502, "camera_not_answering");   // what ffmpeg said can name the camera's address: it is not passed on
    } finally {
      tunnel.close();
    }
  }
}

export type AiObservation = { camera_id: string; severity: "review" | "high"; reasons: string[]; profile: string; motion: number; motion_ratio?: number; regions?: AiRegion[]; radar_tracks: number };

/** A rectangle where the picture moved, in fractions of the picture: the top left corner and the size. */
export type AiRegion = { x: number; y: number; w: number; h: number };

const OBSERVATION_FIELDS = ["camera_id", "severity", "reasons", "profile", "motion", "motion_ratio", "regions", "radar_tracks"];
const MAX_REGIONS = 16;

/** The regions of an observation, checked; undefined when they are not what the contract says (at most 16 objects with exactly x, y, w, h as numbers inside the picture). */
function parseRegions(value: unknown): AiRegion[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REGIONS) return undefined;
  const out: AiRegion[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const item = entry as Record<string, unknown>;
    if (!Object.keys(item).every(key => ["x", "y", "w", "h"].includes(key))) return undefined;
    const { x, y, w, h } = item;
    if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return undefined;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1 && w >= 0.0001 && w <= 1 && h >= 0.0001 && h <= 1)) return undefined;
    out.push({ x, y, w, h });
  }
  return out;
}

/** One followed object of a vision event: where it was heading (a unit direction in the picture, y downwards) and how fast, in pictures per second. */
export type AiVector = { track_id: number; dx: number; dy: number; speed: number };

/** The event of the vision service (ARMOR-COMMON vision_event.schema.json): one object that entered a zone. It authorizes nothing: `authorizes_action` is always false. */
export type VisionEvent = {
  schema: "armor.vision.event/v1" | "armor.vision.event/v2"; type: "alert" | "detection"; camera_id: string; zone_id: string; zone_name: string; track_id: number; label: string;
  confidence: number; box: number[]; timestamp: number; timestamp_ms: number; authorizes_action: false; radar_tracks?: number; vectors?: AiVector[];
};

const VISION_EVENT_FIELDS = ["schema", "type", "camera_id", "zone_id", "zone_name", "track_id", "label", "confidence", "box", "timestamp", "timestamp_ms", "authorizes_action", "radar_tracks", "vectors"];
const MAX_VECTORS = 16;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const inRange = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;

function parseVectors(value: unknown): AiVector[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_VECTORS) return undefined;
  const out: AiVector[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Object.keys(entry).every(key => ["track_id", "dx", "dy", "speed"].includes(key))) return undefined;
    const { track_id, dx, dy, speed } = entry;
    if (typeof track_id !== "number" || !Number.isInteger(track_id) || track_id < 1 || !inRange(dx, -1, 1) || !inRange(dy, -1, 1) || !inRange(speed, 0, 100)) return undefined;
    out.push({ track_id, dx, dy, speed });
  }
  return out;
}

/** The vision event a service sent, checked field by field as the contract says; undefined when it is not what it should be. */
export function parseVisionEvent(input: unknown): VisionEvent | undefined {
  if (!isRecord(input) || !Object.keys(input).every(key => VISION_EVENT_FIELDS.includes(key))) return undefined;
  const item = input;
  if (item.schema !== "armor.vision.event/v1" && item.schema !== "armor.vision.event/v2") return undefined;
  if (item.type !== "alert" && item.type !== "detection") return undefined;
  if (typeof item.camera_id !== "string" || !/^[A-Za-z0-9._-]{3,80}$/.test(item.camera_id)) return undefined;
  if (!text(item.zone_id, 80) || !text(item.zone_name, 120) || !text(item.label, 60)) return undefined;
  if (typeof item.track_id !== "number" || !Number.isInteger(item.track_id) || item.track_id < 1) return undefined;
  if (!inRange(item.confidence, 0, 1) || !Array.isArray(item.box) || item.box.length !== 4 || !item.box.every(v => inRange(v, 0, 1))) return undefined;
  if (typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp) || item.timestamp < 0) return undefined;
  if (typeof item.timestamp_ms !== "number" || !Number.isInteger(item.timestamp_ms) || item.timestamp_ms < 0) return undefined;
  if (item.authorizes_action !== false) return undefined;
  if (item.radar_tracks !== undefined && (typeof item.radar_tracks !== "number" || !Number.isInteger(item.radar_tracks) || item.radar_tracks < 0 || item.radar_tracks > 1000)) return undefined;
  const vectors = item.vectors === undefined ? undefined : parseVectors(item.vectors);
  if (item.vectors !== undefined && vectors === undefined) return undefined;
  return {
    schema: item.schema, type: item.type, camera_id: item.camera_id, zone_id: item.zone_id, zone_name: item.zone_name, track_id: item.track_id, label: item.label, confidence: item.confidence,
    box: item.box as number[], timestamp: item.timestamp, timestamp_ms: item.timestamp_ms, authorizes_action: false,
    ...(item.radar_tracks !== undefined ? { radar_tracks: item.radar_tracks } : {}), ...(vectors !== undefined ? { vectors } : {}),
  };
}

/** The kinds of event the activity engine of ARMOR-VISION reports (zones and counting lines). */
export const ACTIVITY_EVENT_TYPES = ["zone_enter", "zone_exit", "dwell", "loiter", "line_cross"] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * One event of the activity engine (armor.vision.activity/v1): an object entered, left, stayed in or loitered in a zone, or crossed a counting line. `notify: false` is set by the engine when the profile
 * of the arming mode says the people the alarms go to are not told of it; the event is still recorded. It authorizes nothing (`authorizes_action` is always false).
 */
export type ActivityEvent = {
  schema: "armor.vision.activity/v1"; type: ActivityEventType; camera_id: string; track_id: number; label: string; timestamp: number; timestamp_ms: number; authorizes_action: false;
  zone_id?: string; zone_name?: string; seconds?: number; line_id?: string; direction?: "to_left" | "to_right"; notify?: boolean;
};

const ACTIVITY_EVENT_FIELDS = ["schema", "type", "camera_id", "track_id", "label", "timestamp", "timestamp_ms", "authorizes_action", "zone_id", "zone_name", "seconds", "line_id", "direction", "notify"];

/** The activity event a service sent, checked field by field; undefined when it is not what it should be. A zone event names its zone, a line event its line and direction, and nothing else is let through. */
export function parseActivityEvent(input: unknown): ActivityEvent | undefined {
  if (!isRecord(input) || !Object.keys(input).every(key => ACTIVITY_EVENT_FIELDS.includes(key))) return undefined;
  const item = input;
  if (item.schema !== "armor.vision.activity/v1") return undefined;
  if (typeof item.type !== "string" || !(ACTIVITY_EVENT_TYPES as readonly string[]).includes(item.type)) return undefined;
  const type = item.type as ActivityEventType;
  if (typeof item.camera_id !== "string" || !/^[A-Za-z0-9._-]{3,80}$/.test(item.camera_id)) return undefined;
  if (typeof item.track_id !== "number" || !Number.isInteger(item.track_id) || item.track_id < 1) return undefined;
  if (!text(item.label, 60)) return undefined;
  if (typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp) || item.timestamp < 0) return undefined;
  if (typeof item.timestamp_ms !== "number" || !Number.isInteger(item.timestamp_ms) || item.timestamp_ms < 0) return undefined;
  if (item.authorizes_action !== false) return undefined;
  if (item.notify !== undefined && typeof item.notify !== "boolean") return undefined;
  if (item.seconds !== undefined && !inRange(item.seconds, 0, 86_400 * 7)) return undefined;
  if (type === "line_cross") {
    if (!text(item.line_id, 80) || (item.direction !== "to_left" && item.direction !== "to_right")) return undefined;
    if (item.zone_id !== undefined || item.zone_name !== undefined || item.seconds !== undefined) return undefined;
  } else {
    if (!text(item.zone_id, 80) || (item.zone_name !== undefined && !text(item.zone_name, 120))) return undefined;
    if (item.line_id !== undefined || item.direction !== undefined) return undefined;
    if (type !== "zone_enter" && item.seconds === undefined) return undefined;
    if (type === "zone_enter" && item.seconds !== undefined) return undefined;
  }
  return {
    schema: "armor.vision.activity/v1", type, camera_id: item.camera_id, track_id: item.track_id, label: item.label, timestamp: item.timestamp, timestamp_ms: item.timestamp_ms, authorizes_action: false,
    ...(item.zone_id !== undefined ? { zone_id: item.zone_id as string } : {}), ...(item.zone_name !== undefined ? { zone_name: item.zone_name as string } : {}),
    ...(item.seconds !== undefined ? { seconds: item.seconds as number } : {}), ...(item.line_id !== undefined ? { line_id: item.line_id as string } : {}),
    ...(item.direction !== undefined ? { direction: item.direction as "to_left" | "to_right" } : {}), ...(item.notify !== undefined ? { notify: item.notify } : {}),
  };
}

/** The observation a service sent, checked; undefined when it is not what it should be. */
export function parseObservation(input: unknown): AiObservation | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const item = input as Record<string, unknown>;
  if (!Object.keys(item).every(key => OBSERVATION_FIELDS.includes(key))) return undefined;   // the contract names every field (ARMOR-COMMON ai_observation.schema.json)
  const reasons = Array.isArray(item.reasons) ? item.reasons : [];
  if (typeof item.camera_id !== "string" || !/^[A-Za-z0-9._-]{3,80}$/.test(item.camera_id)) return undefined;
  if (item.severity !== "review" && item.severity !== "high") return undefined;
  if (reasons.length > 5 || !reasons.every(reason => typeof reason === "string" && reason.length <= 200)) return undefined;
  if (typeof item.motion !== "number" || typeof item.radar_tracks !== "number" || (item.motion_ratio !== undefined && typeof item.motion_ratio !== "number")) return undefined;   // numbers, as the contract says, never a text that reads as one
  const motion = item.motion, tracks = item.radar_tracks;
  // `motion` is how sure the service is that something moved (0..1); `motion_ratio` is the share of the picture that changed, when the service says it.
  const ratio = item.motion_ratio === undefined ? undefined : item.motion_ratio;
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) return undefined;
  if (!Number.isFinite(motion) || motion < 0 || motion > 1 || !Number.isInteger(tracks) || tracks < 0 || tracks > 1000) return undefined;
  if (typeof item.profile !== "string" || !["daylight", "low-light"].includes(item.profile)) return undefined;
  const regions = item.regions === undefined ? undefined : parseRegions(item.regions);
  if (item.regions !== undefined && regions === undefined) return undefined;
  return { camera_id: item.camera_id, severity: item.severity, reasons: reasons as string[], profile: item.profile, motion, ...(ratio !== undefined ? { motion_ratio: ratio } : {}), ...(regions !== undefined ? { regions } : {}), radar_tracks: tracks };
}
