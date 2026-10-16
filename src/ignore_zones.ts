/**
 * The parts of a camera's picture that the observation service must not look at: a tree that waves, a road, a screen. Each camera has up to sixteen rectangles, as fractions of the
 * picture (x, y, width, height from the top left), set in Studio by an administrator and handed to the observation service with the camera, which takes those pixels out of its
 * movement detection. Nothing is drawn on the video and nothing is cut from it: the pictures, the recordings and the photos stay whole.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export class IgnoreZonesInvalid extends Error {}

export type IgnoreZone = { x: number; y: number; w: number; h: number };
export const MAX_IGNORE_ZONES = 16;
const CAMERA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseIgnoreZones(value: unknown): IgnoreZone[] {
  if (!Array.isArray(value)) throw new IgnoreZonesInvalid("zones must be an array");
  if (value.length > MAX_IGNORE_ZONES) throw new IgnoreZonesInvalid(`at most ${MAX_IGNORE_ZONES} zones`);
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new IgnoreZonesInvalid(`zone ${index} must be an object`);
    const { x, y, w, h, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new IgnoreZonesInvalid(`zone ${index} has an unknown field`);
    for (const [name, number] of [["x", x], ["y", y], ["w", w], ["h", h]] as const) {
      if (typeof number !== "number" || !Number.isFinite(number)) throw new IgnoreZonesInvalid(`zone ${index}: ${name} must be a number`);
    }
    const [fx, fy, fw, fh] = [x, y, w, h].map(number => Math.round((number as number) * 10_000) / 10_000) as [number, number, number, number];
    if (fx < 0 || fy < 0 || fw <= 0 || fh <= 0 || fx + fw > 1.0001 || fy + fh > 1.0001) throw new IgnoreZonesInvalid(`zone ${index} is not inside the picture`);
    return { x: fx, y: fy, w: Math.min(fw, Math.round((1 - fx) * 10_000) / 10_000), h: Math.min(fh, Math.round((1 - fy) * 10_000) / 10_000) };
  });
}

export class IgnoreZones {
  #byCamera = new Map<string, IgnoreZone[]>();

  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [camera, zones] of Object.entries(stored)) if (CAMERA.test(camera)) this.#byCamera.set(camera, parseIgnoreZones(zones));
    } catch { this.#byCamera = new Map(); }
  }

  get(camera: string): IgnoreZone[] { return (this.#byCamera.get(camera) ?? []).map(zone => ({ ...zone })); }

  set(camera: string, value: unknown): IgnoreZone[] {
    if (!CAMERA.test(camera)) throw new IgnoreZonesInvalid("invalid camera id");
    const zones = parseIgnoreZones(value);
    if (zones.length) this.#byCamera.set(camera, zones); else this.#byCamera.delete(camera);
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
