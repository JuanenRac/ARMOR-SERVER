/**
 * A.R.M.O.R. camera watchdog: a camera that stops answering is as important
 * as a radar node that goes silent. Each configured camera is probed with a
 * plain TCP connection (its RTSP or ONVIF port) and its status changes only
 * after consecutive failures, so one dropped packet never raises an event.
 * Nothing is sent to the camera and no credential is used.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { ArmorEventBody } from "../events.js";
import { openPort } from "./discovery.js";
import type { CameraConnection } from "./model.js";

export type CameraStatus = "unknown" | "online" | "offline";
export type CameraHealth = { id: string; status: CameraStatus; since_ms: number | null; last_checked_ms: number | null; consecutive_failures: number };

export type WatcherOptions = {
  list: () => CameraConnection[];
  onEvent: (event: ArmorEventBody) => void;
  probe?: (host: string, port: number) => Promise<boolean>;
  now?: () => number;
  /** Consecutive failed checks before a camera is reported offline. */
  failuresToOffline?: number;
  /** How many cameras are probed at the same time. */
  concurrency?: number;
};

export class CameraWatcher {
  readonly #options: WatcherOptions;
  readonly #probe: (host: string, port: number) => Promise<boolean>;
  readonly #now: () => number;
  readonly #state = new Map<string, CameraHealth>();
  #running = false;

  constructor(options: WatcherOptions) {
    this.#options = options;
    this.#probe = options.probe ?? ((host, port) => openPort(host, port, 2_000));
    this.#now = options.now ?? Date.now;
  }

  /** The health of every configured camera; a removed camera disappears at the next check. */
  snapshot(): CameraHealth[] {
    return this.#options.list().map(camera => this.#state.get(camera.id) ?? { id: camera.id, status: "unknown", since_ms: null, last_checked_ms: null, consecutive_failures: 0 });
  }

  /** One pass over every camera. A pass that is still running is not started twice. */
  async check(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const cameras = this.#options.list();
      const present = new Set(cameras.map(camera => camera.id));
      for (const id of [...this.#state.keys()]) if (!present.has(id)) this.#state.delete(id);
      const width = Math.max(1, this.#options.concurrency ?? 4);
      for (let start = 0; start < cameras.length; start += width) {
        await Promise.all(cameras.slice(start, start + width).map(camera => this.#checkOne(camera)));
      }
    } finally { this.#running = false; }
  }

  async #checkOne(camera: CameraConnection): Promise<void> {
    // Either service answering proves the camera is on the network and powered.
    const ports = [...new Set([camera.rtspPort, camera.onvifPort])];
    let reachable = false;
    try { reachable = (await Promise.all(ports.map(port => this.#probe(camera.host, port)))).some(Boolean); } catch { reachable = false; }
    const now = this.#now();
    const previous = this.#state.get(camera.id);
    const failures = reachable ? 0 : (previous?.consecutive_failures ?? 0) + 1;
    const threshold = this.#options.failuresToOffline ?? 2;
    let status: CameraStatus = previous?.status ?? "unknown";
    if (reachable) status = "online";
    else if (failures >= threshold) status = "offline";
    // A camera that has never been reachable stays "unknown" until the threshold, then offline.
    const changed = status !== (previous?.status ?? "unknown");
    this.#state.set(camera.id, { id: camera.id, status, since_ms: changed || !previous ? now : previous.since_ms, last_checked_ms: now, consecutive_failures: failures });
    // The first sighting of an online camera is not news; a first sighting that is offline is.
    if (changed && !(status === "online" && !previous)) this.#options.onEvent({ type: "camera", camera_id: camera.id, from: previous?.status ?? "unknown", to: status });
  }
}
