/**
 * Live-video relay: one FFmpeg process per camera turns RTSP into MJPEG for
 * every viewer of that camera. The RTSP source stays inside this process.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { mediaError } from "../cameras/errors.js";
import { rtspUrl, type CameraConnection } from "../cameras/model.js";

type Relay = { process: ChildProcess; subscribers: Set<ServerResponse>; stopTimer?: ReturnType<typeof setTimeout> };

export type RelayOptions = { ffmpegPath: string; maxRelays: number; idleStopMs?: number };

export class RelayManager {
  readonly #relays = new Map<string, Relay>();
  readonly #options: RelayOptions;
  constructor(options: RelayOptions) { this.#options = options; }

  get active(): number { return this.#relays.size; }
  get capacity(): number { return this.#options.maxRelays; }

  /** Attach a viewer to the camera's relay, starting it when this is the first viewer. */
  attach(camera: CameraConnection, viewer: ServerResponse): () => void {
    const relay = this.#relayFor(camera);
    relay.subscribers.add(viewer);
    return () => {
      relay.subscribers.delete(viewer);
      this.#stopWhenUnused(camera.id, relay);
    };
  }

  /** Stop a camera's relay now (its connection was removed or changed). */
  stop(cameraId: string): void { this.#relays.get(cameraId)?.process.kill("SIGTERM"); }

  #relayFor(camera: CameraConnection): Relay {
    const existing = this.#relays.get(camera.id);
    if (existing) {
      if (existing.stopTimer) { clearTimeout(existing.stopTimer); existing.stopTimer = undefined; }
      return existing;
    }
    if (this.#relays.size >= this.#options.maxRelays) throw mediaError("the local live-video relay capacity is currently exhausted");
    const source = rtspUrl(camera);
    if (!source) throw mediaError("camera RTSP path and complete credentials are required");
    if (!this.#options.ffmpegPath) throw mediaError("FFmpeg is not configured");
    const child = spawn(this.#options.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", source,
      "-an", "-vf", "fps=10,scale=960:-2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "armorframe", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const relay: Relay = { process: child, subscribers: new Set() };
    this.#relays.set(camera.id, relay);
    child.stdout?.on("data", chunk => { for (const client of relay.subscribers) if (!client.writableEnded) client.write(chunk); });
    const close = () => this.#close(camera.id, relay);
    child.once("error", close);
    child.once("close", close);
    return relay;
  }

  #stopWhenUnused(cameraId: string, relay: Relay): void {
    if (relay.subscribers.size || relay.stopTimer) return;
    relay.stopTimer = setTimeout(() => { if (!relay.subscribers.size) relay.process.kill("SIGTERM"); }, this.#options.idleStopMs ?? 5_000);
  }

  #close(cameraId: string, relay: Relay): void {
    if (this.#relays.get(cameraId) !== relay) return;
    if (relay.stopTimer) clearTimeout(relay.stopTimer);
    this.#relays.delete(cameraId);
    for (const client of relay.subscribers) if (!client.writableEnded) client.end();
    relay.subscribers.clear();
  }
}

/** Short-lived, camera-bound grants that let an <img> tag load a stream without any header. */
export class StreamTickets {
  readonly #tickets = new Map<string, { cameraId: string; expiresAt: number }>();
  readonly #lifetimeMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  constructor(lifetimeMs = 5 * 60_000, capacity = 256, now: () => number = Date.now) { this.#lifetimeMs = lifetimeMs; this.#capacity = capacity; this.#now = now; }

  issue(cameraId: string): { ticket: string; expiresAt: string } {
    const now = this.#now();
    for (const [ticket, grant] of this.#tickets) if (grant.expiresAt <= now) this.#tickets.delete(ticket);
    while (this.#tickets.size >= this.#capacity) this.#tickets.delete(this.#tickets.keys().next().value!);
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = now + this.#lifetimeMs;
    this.#tickets.set(ticket, { cameraId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** True only for an unexpired ticket that was issued for this very camera. */
  valid(ticket: unknown, cameraId: string): boolean {
    if (typeof ticket !== "string") return false;
    const grant = this.#tickets.get(ticket);
    if (!grant || grant.expiresAt <= this.#now()) { if (grant) this.#tickets.delete(ticket); return false; }
    return grant.cameraId === cameraId;
  }
}
