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

export type AiObservation = { camera_id: string; severity: "review" | "high"; reasons: string[]; profile: string; motion: number; motion_ratio?: number; radar_tracks: number };

/** The observation a service sent, checked; undefined when it is not what it should be. */
export function parseObservation(input: unknown): AiObservation | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const item = input as Record<string, unknown>;
  const reasons = Array.isArray(item.reasons) ? item.reasons : [];
  if (typeof item.camera_id !== "string" || !/^[A-Za-z0-9._-]{3,80}$/.test(item.camera_id)) return undefined;
  if (item.severity !== "review" && item.severity !== "high") return undefined;
  if (reasons.length > 5 || !reasons.every(reason => typeof reason === "string" && reason.length <= 200)) return undefined;
  const motion = Number(item.motion), tracks = Number(item.radar_tracks);
  // `motion` is how sure the service is that something moved (0..1); `motion_ratio` is the share of the picture that changed, when the service says it.
  const ratio = item.motion_ratio === undefined ? undefined : Number(item.motion_ratio);
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) return undefined;
  if (!Number.isFinite(motion) || motion < 0 || motion > 1 || !Number.isInteger(tracks) || tracks < 0 || tracks > 1000) return undefined;
  if (typeof item.profile !== "string" || !["daylight", "low-light"].includes(item.profile)) return undefined;
  return { camera_id: item.camera_id, severity: item.severity, reasons: reasons as string[], profile: item.profile, motion, ...(ratio !== undefined ? { motion_ratio: ratio } : {}), radar_tracks: tracks };
}
