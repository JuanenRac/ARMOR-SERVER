/**
 * Evidence taken by the cameras of a zone when an alarm sounds. Until now a capture started only when the vision service saw something (see capture_on_detect.ts); here an alarm of a
 * node or of an alarm panel does it too: when it is raised with a high or critical severity (or a node's alert level goes to high), every camera that the site design says is covered by that
 * node (ai_cover.ts: a camera and a radar are placed on the plan, so a radar within the reach of a camera covers it) takes the photos and the video of the capture settings, through the same
 * `CaptureOnDetect` (so its settings and the cooldown of each camera apply). It is behind a security option that is off by default (`capture.on_alarm`) and it starts at most
 * `capture.on_alarm_per_min` captures a minute in all, so a burst of alarms cannot fill the disk. A silent (duress) alarm never starts one: nothing about it may be visible. A camera the design
 * cannot place is left alone (the link between alarm and camera is the design, never a guess). What is not taken is audited, never raised as an alarm of its own.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AuditLog } from "./audit.js";
import type { CameraConnection } from "./cameras/model.js";
import type { ArmorEvent } from "./events.js";
import { coveringNodes } from "./ai_cover.js";
import type { CaptureRecord } from "./capture_on_detect.js";

export type AlarmCaptureOptions = {
  /** `capture.on_alarm`. */
  enabled: () => boolean;
  /** `capture.on_alarm_per_min`. */
  perMinute: () => number;
  /** The site design, as stored (null: none). */
  site: () => Record<string, unknown> | null;
  /** The cameras the server can look at. */
  cameras: () => CameraConnection[];
  trigger: (camera: CameraConnection) => Promise<CaptureRecord | null>;
  audit: AuditLog;
  now?: () => number;
};

const WINDOW_MS = 60_000;

/** The node an event is about when it is a high alarm that should be photographed; undefined for anything else (silent alarms, cameras, lower severities, an alarm that ends). */
export function nodeOfAlarmEvent(event: ArmorEvent): string | undefined {
  if (event.type === "alert") return event.to === "high" ? event.node_id : undefined;
  if (event.type === "alarm") {
    if (event.state !== "raised" || event.silent) return undefined;
    if (event.severity !== "high" && event.severity !== "critical") return undefined;
    if (event.source_type === "camera") return undefined;   // a camera that saw something already starts its own capture
    return event.source;
  }
  return undefined;
}

export class AlarmCapture {
  readonly #options: AlarmCaptureOptions;
  readonly #starts: number[] = [];

  constructor(options: AlarmCaptureOptions) { this.#options = options; }

  /** Told of every event of the history. Never throws and never waits: the captures go on by themselves. Returns how many cameras were asked. */
  handle(event: ArmorEvent): number {
    try {
      if (!this.#options.enabled()) return 0;
      const node = nodeOfAlarmEvent(event);
      if (node === undefined) return 0;
      const design = this.#options.site();
      const cameras = this.#options.cameras().filter(camera => coveringNodes(design, camera.id)?.includes(node));
      if (cameras.length === 0) return 0;
      const now = (this.#options.now ?? Date.now)();
      while (this.#starts.length > 0 && now - this.#starts[0] >= WINDOW_MS) this.#starts.shift();
      let asked = 0;
      for (const camera of cameras) {
        if (this.#starts.length >= this.#options.perMinute()) {
          this.#options.audit.record({ action: "evidence.alarm_capture", outcome: "denied", target: camera.id, detail: `rate limit, for ${node}` });
          continue;
        }
        this.#starts.push(now);
        asked += 1;
        this.#options.trigger(camera).catch(() => undefined);
        this.#options.audit.record({ action: "evidence.alarm_capture", outcome: "allowed", target: camera.id, detail: `alarm of ${node}` });
      }
      return asked;
    } catch { return 0; }
  }
}
