/**
 * The counting lines of a camera: segments drawn on the picture that the observation service counts a crossing of, in both directions, for the objects it follows. Each camera has up
 * to sixteen lines, set in Studio by an administrator; a line has a name, two different ends as [x, y] fractions of the picture (from the top left) and, optionally, the labels it
 * counts (all of them when it says none). Nothing is drawn on the video: the pictures, the recordings and the photos stay whole.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";
import { CAMERA_ID } from "./cameras/model.js";

export class CountLinesInvalid extends Error {}

export type CountLine = { id: string; a: [number, number]; b: [number, number]; labels?: string[] };
export const MAX_COUNT_LINES = 16;
export const MAX_COUNT_LINE_LABELS = 8;
const LINE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LABEL = /^[a-z][a-z0-9_-]{0,31}$/;

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function parseEnd(value: unknown, index: number, name: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new CountLinesInvalid(`line ${index}: ${name} must be [x, y]`);
  const [x, y] = value as unknown[];
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new CountLinesInvalid(`line ${index}: ${name} must be two numbers`);
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new CountLinesInvalid(`line ${index}: ${name} is not inside the picture`);
  return [round(x), round(y)];
}

export function parseCountLines(value: unknown): CountLine[] {
  if (!Array.isArray(value)) throw new CountLinesInvalid("lines must be an array");
  if (value.length > MAX_COUNT_LINES) throw new CountLinesInvalid(`at most ${MAX_COUNT_LINES} lines`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CountLinesInvalid(`line ${index} must be an object`);
    const { id, a, b, labels, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new CountLinesInvalid(`line ${index} has an unknown field`);
    if (typeof id !== "string" || !LINE_ID.test(id)) throw new CountLinesInvalid(`line ${index}: id must be 1 to 32 characters of a-z, 0-9, - and _`);
    if (seen.has(id)) throw new CountLinesInvalid(`line ${index}: the name ${id} is used twice`);
    seen.add(id);
    const start = parseEnd(a, index, "a");
    const end = parseEnd(b, index, "b");
    if (start[0] === end[0] && start[1] === end[1]) throw new CountLinesInvalid(`line ${index}: a and b are the same point`);
    const line: CountLine = { id, a: start, b: end };
    if (labels !== undefined) {
      if (!Array.isArray(labels) || labels.length > MAX_COUNT_LINE_LABELS || !labels.every(label => typeof label === "string" && LABEL.test(label))) throw new CountLinesInvalid(`line ${index}: labels must be up to ${MAX_COUNT_LINE_LABELS} names`);
      if (labels.length) line.labels = [...new Set(labels as string[])];
    }
    return line;
  });
}

export class CountLines {
  #byCamera = new Map<string, CountLine[]>();

  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [camera, lines] of Object.entries(stored)) {
        if (!CAMERA_ID.test(camera)) continue;
        try { this.#byCamera.set(camera, parseCountLines(lines)); } catch { /* one damaged entry loses only its own camera's lines */ }
      }
    } catch { this.#byCamera = new Map(); }
  }

  get(camera: string): CountLine[] { return (this.#byCamera.get(camera) ?? []).map(line => ({ ...line, a: [...line.a], b: [...line.b], ...(line.labels ? { labels: [...line.labels] } : {}) })); }

  set(camera: string, value: unknown): CountLine[] {
    if (!CAMERA_ID.test(camera)) throw new CountLinesInvalid("invalid camera id");
    const lines = parseCountLines(value);
    if (lines.length) this.#byCamera.set(camera, lines); else this.#byCamera.delete(camera);
    this.#save();
    return this.get(camera);
  }

  /** A camera that is deleted takes its lines with it. */
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
