/**
 * The detection zones of a camera and what is watched in each arming mode. A zone is a polygon drawn on the picture (three to twelve corners as [x, y] fractions of the picture from
 * the top left) with a name, the kind (alert: raises an alert; detection: only recorded), the labels it counts (all of them when it says none) and how long an object must stay in it
 * before it counts (frames and seconds). The shape follows the zones of the ARMOR-VISION configuration, so the observation service can take them as they are. Besides the zones, a camera
 * has one profile per arming mode (away, home, night, disarmed): which zones are watched, how sensitive the detection is and whether it is told to the people the alarms go to. A mode
 * with no profile watches every zone with the normal sensitivity and tells it, so an unknown mode never silently watches less. Set in Studio by an administrator; nothing is drawn on the
 * video and the pictures, the recordings and the photos stay whole.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";
import { CAMERA_ID } from "./cameras/model.js";

export class DetectionZonesInvalid extends Error {}

export const ZONE_KINDS = ["alert", "detection"] as const;
export const PROFILE_MODES = ["away", "home", "night", "disarmed"] as const;
export const SENSITIVITIES = ["low", "normal", "high"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export type ProfileMode = (typeof PROFILE_MODES)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];

export type DetectionZone = { id: string; name: string; points: Array<[number, number]>; kind: ZoneKind; labels: string[]; min_frames: number; min_seconds: number };
export type ModeProfile = { watch: string[]; sensitivity: Sensitivity; notify: boolean };
export type CameraDetection = { zones: DetectionZone[]; profiles: Partial<Record<ProfileMode, ModeProfile>> };

export const MAX_DETECTION_ZONES = 16;
export const MIN_ZONE_POINTS = 3;
export const MAX_ZONE_POINTS = 12;
export const MAX_ZONE_LABELS = 8;
const ZONE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LABEL = /^[a-z][a-z0-9_-]{0,31}$/;
const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The area of a polygon (shoelace); zero for a polygon that is a line. */
export function polygonArea(points: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  points.forEach((point, index) => { const next = points[(index + 1) % points.length]!; sum += point[0] * next[1] - next[0] * point[1]; });
  return Math.abs(sum) / 2;
}

function orientation(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(value) < 1e-12 ? 0 : value > 0 ? 1 : -1;
}
const onSegment = (a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): boolean => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
function segmentsCross(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]): boolean {
  const [o1, o2, o3, o4] = [orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}
/** True when two sides of the polygon that are not neighbours touch or cross: such a shape has no clear inside. */
export function selfIntersects(points: ReadonlyArray<readonly [number, number]>): boolean {
  const count = points.length;
  for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
    if (j === i + 1 || (i === 0 && j === count - 1)) continue;
    if (segmentsCross(points[i]!, points[(i + 1) % count]!, points[j]!, points[(j + 1) % count]!)) return true;
  }
  return false;
}

function parsePoint(value: unknown, where: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new DetectionZonesInvalid(`${where}: a corner must be [x, y]`);
  const [x, y] = value as unknown[];
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new DetectionZonesInvalid(`${where}: a corner must be two numbers`);
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new DetectionZonesInvalid(`${where}: a corner is not inside the picture`);
  return [round(x), round(y)];
}

function parseZone(item: unknown, index: number): DetectionZone {
  const where = `zone ${index}`;
  if (!isRecord(item)) throw new DetectionZonesInvalid(`${where} must be an object`);
  const { id, name, points, kind, labels, min_frames, min_seconds, ...rest } = item;
  if (Object.keys(rest).length) throw new DetectionZonesInvalid(`${where} has an unknown field`);
  if (typeof id !== "string" || !ZONE_ID.test(id)) throw new DetectionZonesInvalid(`${where}: id must be 1 to 32 characters of a-z, 0-9, - and _`);
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 60) throw new DetectionZonesInvalid(`${where}: name must be 1 to 60 characters`);
  if (!Array.isArray(points) || points.length < MIN_ZONE_POINTS || points.length > MAX_ZONE_POINTS) throw new DetectionZonesInvalid(`${where}: ${MIN_ZONE_POINTS} to ${MAX_ZONE_POINTS} corners`);
  const corners = points.map(point => parsePoint(point, where));
  if (polygonArea(corners) < 0.0001) throw new DetectionZonesInvalid(`${where}: the corners enclose no area`);
  if (selfIntersects(corners)) throw new DetectionZonesInvalid(`${where}: the sides cross each other`);
  if (kind !== undefined && !(ZONE_KINDS as readonly unknown[]).includes(kind)) throw new DetectionZonesInvalid(`${where}: kind is alert or detection`);
  let cleanLabels: string[] = [];
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length > MAX_ZONE_LABELS || !labels.every(label => typeof label === "string" && LABEL.test(label))) throw new DetectionZonesInvalid(`${where}: labels must be up to ${MAX_ZONE_LABELS} names of a-z, 0-9, - and _`);
    cleanLabels = [...new Set(labels as string[])];
  }
  const frames = min_frames ?? 1, seconds = min_seconds ?? 0;
  if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 300) throw new DetectionZonesInvalid(`${where}: min_frames is a whole number from 1 to 300`);
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new DetectionZonesInvalid(`${where}: min_seconds is from 0 to 3600`);
  return { id, name: name.trim(), points: corners, kind: (kind as ZoneKind | undefined) ?? "alert", labels: cleanLabels, min_frames: frames, min_seconds: round(seconds) };
}

export function parseCameraDetection(value: unknown): CameraDetection {
  if (!isRecord(value)) throw new DetectionZonesInvalid("the body must be an object with zones and profiles");
  const { zones, profiles, ...rest } = value;
  if (Object.keys(rest).length) throw new DetectionZonesInvalid("unknown field");
  if (!Array.isArray(zones)) throw new DetectionZonesInvalid("zones must be an array");
  if (zones.length > MAX_DETECTION_ZONES) throw new DetectionZonesInvalid(`at most ${MAX_DETECTION_ZONES} zones`);
  const parsed = zones.map(parseZone);
  const ids = new Set<string>();
  for (const zone of parsed) { if (ids.has(zone.id)) throw new DetectionZonesInvalid(`the name ${zone.id} is used twice`); ids.add(zone.id); }
  const cleanProfiles: Partial<Record<ProfileMode, ModeProfile>> = {};
  if (profiles !== undefined) {
    if (!isRecord(profiles)) throw new DetectionZonesInvalid("profiles must be an object");
    for (const [mode, raw] of Object.entries(profiles)) {
      if (!(PROFILE_MODES as readonly string[]).includes(mode)) throw new DetectionZonesInvalid(`unknown mode ${mode.slice(0, 20)}`);
      if (!isRecord(raw)) throw new DetectionZonesInvalid(`profile ${mode} must be an object`);
      const { watch, sensitivity, notify, ...more } = raw;
      if (Object.keys(more).length) throw new DetectionZonesInvalid(`profile ${mode} has an unknown field`);
      if (!Array.isArray(watch) || !watch.every(id => typeof id === "string" && ids.has(id))) throw new DetectionZonesInvalid(`profile ${mode}: watch lists the ids of zones of this camera`);
      if (sensitivity !== undefined && !(SENSITIVITIES as readonly unknown[]).includes(sensitivity)) throw new DetectionZonesInvalid(`profile ${mode}: sensitivity is low, normal or high`);
      if (notify !== undefined && typeof notify !== "boolean") throw new DetectionZonesInvalid(`profile ${mode}: notify is true or false`);
      cleanProfiles[mode as ProfileMode] = { watch: [...new Set(watch as string[])], sensitivity: (sensitivity as Sensitivity | undefined) ?? "normal", notify: (notify as boolean | undefined) ?? true };
    }
  }
  return { zones: parsed, profiles: cleanProfiles };
}

/** The zones that count in a mode: every zone when the mode has no profile (an unknown mode never watches less), else the ones the profile lists. */
export function watchedZones(detection: CameraDetection, mode: string | null | undefined): DetectionZone[] {
  const profile = mode ? detection.profiles[mode as ProfileMode] : undefined;
  if (!profile) return detection.zones;
  const wanted = new Set(profile.watch);
  return detection.zones.filter(zone => wanted.has(zone.id));
}

const clone = (detection: CameraDetection): CameraDetection => JSON.parse(JSON.stringify(detection)) as CameraDetection;

export class DetectionZones {
  #byCamera = new Map<string, CameraDetection>();

  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [camera, detection] of Object.entries(stored)) {
        if (!CAMERA_ID.test(camera)) continue;
        try { this.#byCamera.set(camera, parseCameraDetection(detection)); } catch { /* one damaged entry loses only its own camera's zones */ }
      }
    } catch { this.#byCamera = new Map(); }
  }

  get(camera: string): CameraDetection { return clone(this.#byCamera.get(camera) ?? { zones: [], profiles: {} }); }

  set(camera: string, value: unknown): CameraDetection {
    if (!CAMERA_ID.test(camera)) throw new DetectionZonesInvalid("invalid camera id");
    const detection = parseCameraDetection(value);
    if (detection.zones.length) this.#byCamera.set(camera, detection); else this.#byCamera.delete(camera);
    this.#save();
    return this.get(camera);
  }

  /** A camera that is deleted takes its zones with it. */
  forget(camera: string): void {
    if (this.#byCamera.delete(camera)) this.#save();
  }

  #save(): void {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#byCamera), null, 2), { mode: 0o600 });
    durableRename(temporary, this.file);
  }
}
