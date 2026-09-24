/**
 * Evidence library: snapshots and recordings kept under one directory tree,
 * with validated names, capacity and age limits, protection against pruning
 * and a SHA-256 for chain of custody. Camera credentials never enter a file
 * name, a catalogue entry or a log line.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CAMERA_ID, rtspUrl, type CameraConnection } from "../cameras/model.js";
import { mediaError } from "../cameras/errors.js";

export type MediaKind = "snapshots" | "recordings";
export type PublicMediaKind = "snapshot" | "recording";
export type MediaItem = { id: string; cameraId: string; kind: PublicMediaKind; file: string; createdAt: string; bytes: number; protected: boolean };

export type EvidenceOptions = {
  root: string; ffmpegPath: string; maxBytes: number; retentionMs: number;
  /** Extra text for a failed recording's server log; never sent to a client. */
  warn?: (message: string) => void;
};

type ActiveRecording = { process: ChildProcess; cameraId: string; temporaryPath: string; completedPath: string; startedAt: string; stopRequested: boolean; settled: Promise<MediaItem> };

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:jpg|mp4)$/i;
const PROTECTED_SUFFIX = ".protected";
export const publicKind = (kind: MediaKind): PublicMediaKind => kind === "snapshots" ? "snapshot" : "recording";
export const mediaKindFrom = (value: unknown): MediaKind | null => value === "snapshots" ? "snapshots" : value === "recordings" ? "recordings" : null;

export class EvidenceLibrary {
  readonly #options: EvidenceOptions;
  readonly #active = new Map<string, ActiveRecording>();
  constructor(options: EvidenceOptions) { this.#options = options; }

  get root(): string { return this.#options.root; }
  get activeCameraIds(): string[] { return [...this.#active.keys()]; }
  isRecording(cameraId: string): boolean { return this.#active.has(cameraId); }

  directory(cameraId: string, kind: MediaKind): string {
    if (!CAMERA_ID.test(cameraId)) throw mediaError("invalid camera identifier");
    return path.join(this.#options.root, cameraId, kind);
  }

  /** The absolute path of a catalogue file, or null when the name is unsafe. */
  file(cameraId: string, kind: MediaKind, file: string): string | null {
    if (file.includes(".part.") || !FILE_NAME.test(file) || !CAMERA_ID.test(cameraId)) return null;
    const folder = path.resolve(this.directory(cameraId, kind));
    const target = path.resolve(folder, file);
    return target.startsWith(`${folder}${path.sep}`) ? target : null;
  }

  #item(cameraId: string, kind: MediaKind, file: string, stats: fs.Stats): MediaItem {
    return {
      id: `${cameraId}/${kind}/${file}`, cameraId, kind: publicKind(kind), file,
      // Evidence is never rewritten after it is finalized, so the modification time is the capture time on every filesystem (creation time is not kept everywhere).
      createdAt: stats.mtime.toISOString(), bytes: stats.size,
      protected: fs.existsSync(`${path.join(this.directory(cameraId, kind), file)}${PROTECTED_SUFFIX}`),
    };
  }

  item(cameraId: string, kind: MediaKind, file: string): MediaItem | null {
    const target = this.file(cameraId, kind, file);
    if (!target) return null;
    try {
      const stats = fs.statSync(target);
      return stats.isFile() && stats.size > 0 ? this.#item(cameraId, kind, file, stats) : null;
    } catch { return null; }
  }

  /** The whole catalogue, newest first. Reads the directories without blocking the event loop. */
  async list(): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    let cameras: fs.Dirent[];
    try { cameras = await fsp.readdir(this.#options.root, { withFileTypes: true }); } catch { return []; }
    for (const camera of cameras) {
      if (!camera.isDirectory() || !CAMERA_ID.test(camera.name)) continue;
      for (const kind of ["snapshots", "recordings"] as const) {
        let entries: fs.Dirent[];
        try { entries = await fsp.readdir(this.directory(camera.name, kind), { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const found = this.item(camera.name, kind, entry.name);
          if (found) items.push(found);
        }
      }
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Delete oldest-first past the age or capacity limit. Protected evidence is never pruned. */
  async prune(): Promise<number> {
    const now = Date.now();
    const oldestFirst = (await this.list()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let total = oldestFirst.reduce((sum, item) => sum + item.bytes, 0);
    let removed = 0;
    for (const item of oldestFirst) {
      if (item.protected) continue;
      const expired = this.#options.retentionMs > 0 && Date.parse(item.createdAt) < now - this.#options.retentionMs;
      if (!expired && total <= this.#options.maxBytes) continue;
      const target = this.file(item.cameraId, item.kind === "snapshot" ? "snapshots" : "recordings", item.file);
      if (!target) continue;
      try { await fsp.rm(target, { force: true }); total -= item.bytes; removed += 1; } catch { /* Retention is best effort. */ }
    }
    return removed;
  }

  /** Mark or unmark a file as protected from automatic pruning. Returns false when it does not exist. */
  setProtected(cameraId: string, kind: MediaKind, file: string, value: boolean): boolean {
    const target = this.file(cameraId, kind, file);
    if (!target || !fs.existsSync(target)) return false;
    const marker = `${target}${PROTECTED_SUFFIX}`;
    if (value) fs.writeFileSync(marker, "", { mode: 0o600 });
    else fs.rmSync(marker, { force: true });
    return true;
  }

  /** SHA-256 of one file, streamed, for chain-of-custody records. */
  async sha256(cameraId: string, kind: MediaKind, file: string): Promise<string | null> {
    const target = this.file(cameraId, kind, file);
    if (!target || !fs.existsSync(target)) return null;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  remove(cameraId: string, kind: MediaKind, file: string): boolean {
    const target = this.file(cameraId, kind, file);
    if (!target || !fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    fs.rmSync(`${target}${PROTECTED_SUFFIX}`, { force: true });
    return true;
  }

  /** Delete every non-protected file of the given kinds; returns how many were removed. */
  async removeAll(kinds: MediaKind[]): Promise<number> {
    let deleted = 0;
    for (const item of await this.list()) {
      const kind: MediaKind = item.kind === "snapshot" ? "snapshots" : "recordings";
      if (!kinds.includes(kind) || item.protected) continue;
      if (this.remove(item.cameraId, kind, item.file)) deleted += 1;
    }
    return deleted;
  }

  #runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#options.ffmpegPath) { reject(mediaError("FFmpeg is not configured")); return; }
      const child = spawn(this.#options.ffmpegPath, args, { stdio: "ignore", windowsHide: true });
      const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.once("error", () => { clearTimeout(timeout); reject(mediaError("configured FFmpeg executable could not start")); });
      child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(mediaError("FFmpeg could not complete the camera operation")); });
    });
  }

  static fileName(prefix: string, extension: "jpg" | "mp4"): string {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.${extension}`;
  }

  async snapshot(camera: CameraConnection): Promise<MediaItem> {
    const source = rtspUrl(camera);
    if (!source) throw mediaError("camera RTSP path and complete credentials are required");
    await this.prune();
    const folder = this.directory(camera.id, "snapshots");
    fs.mkdirSync(folder, { recursive: true });
    const file = EvidenceLibrary.fileName("snapshot", "jpg");
    const destination = path.join(folder, file);
    try {
      await this.#runFfmpeg(["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", source, "-frames:v", "1", "-q:v", "3", "-y", destination], 20_000);
      const item = this.item(camera.id, "snapshots", file);
      if (!item) throw mediaError("snapshot file was not produced");
      return item;
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
  }

  async startRecording(camera: CameraConnection): Promise<{ cameraId: string; startedAt: string }> {
    const existing = this.#active.get(camera.id);
    if (existing) return { cameraId: existing.cameraId, startedAt: existing.startedAt };
    const source = rtspUrl(camera);
    if (!source) throw mediaError("camera RTSP path and complete credentials are required");
    if (!this.#options.ffmpegPath) throw mediaError("FFmpeg is not configured");
    await this.prune();
    const folder = this.directory(camera.id, "recordings");
    fs.mkdirSync(folder, { recursive: true });
    const file = EvidenceLibrary.fileName("recording", "mp4");
    const completedPath = path.join(folder, file);
    const temporaryPath = `${completedPath}.part.mp4`;
    // Copy the camera's encoded video instead of re-encoding it: a low-power
    // gateway stays responsive and the file simply starts at the next keyframe.
    const child = spawn(this.#options.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", source, "-an", "-c:v", "copy", "-movflags", "+faststart", "-y", temporaryPath], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let errorOutput = "";
    child.stderr?.on("data", chunk => { if (errorOutput.length < 1200) errorOutput += chunk.toString("utf8"); });
    let resolveSettled!: (item: MediaItem) => void;
    let rejectSettled!: (reason: Error) => void;
    const settled = new Promise<MediaItem>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
    settled.catch(() => undefined); // A recording nobody awaits must not raise an unhandled rejection.
    const active: ActiveRecording = { process: child, cameraId: camera.id, temporaryPath, completedPath, startedAt: new Date().toISOString(), stopRequested: false, settled };
    this.#active.set(camera.id, active);
    child.once("error", () => {
      this.#active.delete(camera.id);
      fs.rmSync(temporaryPath, { force: true });
      rejectSettled(mediaError("configured FFmpeg executable could not start"));
    });
    child.once("close", code => {
      this.#active.delete(camera.id);
      try {
        // Some Windows FFmpeg builds exit non-zero after a deliberate stop even
        // with a valid MP4 trailer, so the finished file is the evidence.
        if ((!active.stopRequested && code !== 0) || !fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size < 4096) {
          this.#options.warn?.(`ARMOR_RECORDING=FAILED camera=${camera.id} exit=${code ?? "unknown"} detail=${errorOutput.replace(/rtsp:\/\/[^\s@]+@/gi, "rtsp://***@").slice(0, 700)}`);
          throw mediaError("recording could not be finalized");
        }
        fs.renameSync(temporaryPath, completedPath);
        const item = this.item(camera.id, "recordings", file);
        if (!item) throw mediaError("recording file was not produced");
        resolveSettled(item);
      } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        fs.rmSync(completedPath, { force: true });
        rejectSettled(error instanceof Error ? error : mediaError("recording could not be finalized"));
      }
    });
    return { cameraId: camera.id, startedAt: active.startedAt };
  }

  /** Stop a recording cleanly and resolve with the finished file. */
  async stopRecording(cameraId: string): Promise<MediaItem> {
    const active = this.#active.get(cameraId);
    if (!active) throw mediaError("camera is not recording");
    active.stopRequested = true;
    // FFmpeg's `q` command closes the MP4 muxer and writes its trailer; a bare signal can leave an unplayable file.
    if (active.process.stdin?.writable) active.process.stdin.write("q\n");
    else active.process.kill("SIGINT");
    const forceStop = setTimeout(() => active.process.kill("SIGTERM"), 8_000);
    try { return await active.settled; } finally { clearTimeout(forceStop); }
  }
}
