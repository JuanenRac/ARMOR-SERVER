/**
 * Escalation: a critical alarm that nobody has acknowledged after a set number of minutes is told again, once, to every place the alarms go (the webhook, MQTT, Telegram, Home Assistant),
 * worded as unattended, so that it reaches another person or another channel than the first message did. It stops being watched as soon as it is acknowledged or ends.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Alarm } from "./alarms.js";
import type { AlertMessage } from "./notify.js";
import type { SecurityMode } from "./store.js";

export type EscalatorOptions = {
  afterMin: number;
  active: () => readonly Alarm[];
  send: (message: AlertMessage) => void;
  mode: () => SecurityMode;
  now?: () => number;
};

export class Escalator {
  readonly #options: EscalatorOptions;
  readonly #told = new Set<string>();

  constructor(options: EscalatorOptions) { this.#options = options; }

  /** One look at the alarms (cheap: called every few seconds). Returns how many were escalated. */
  tick(): number {
    const { afterMin, active, send, mode } = this.#options;
    if (afterMin <= 0) return 0;
    const now = (this.#options.now ?? Date.now)();
    const list = active();
    const live = new Set(list.map(alarm => alarm.id));
    for (const id of this.#told) if (!live.has(id)) this.#told.delete(id);
    let count = 0;
    for (const alarm of list) {
      if (alarm.severity !== "critical" || (alarm.acknowledged_at && !alarm.acknowledged_unverified) || alarm.cleared_at || this.#told.has(alarm.id)) continue;
      const waited = now - Date.parse(alarm.raised_at);
      if (!Number.isFinite(waited) || waited < afterMin * 60_000) continue;
      this.#told.add(alarm.id);
      send({ service: "armor-server", event: "alarm.escalated", at: new Date(now).toISOString(), mode: mode(), alarm_id: alarm.id, severity: alarm.severity, code: alarm.code, minutes: Math.floor(waited / 60_000),
        ...(alarm.source.type === "device" ? { device_id: alarm.source.id } : alarm.source.type === "camera" ? { camera_id: alarm.source.id } : alarm.source.type === "node" ? { node_id: alarm.source.id } : {}) });
      count += 1;
    }
    return count;
  }
}
