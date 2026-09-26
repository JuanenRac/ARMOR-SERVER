/**
 * A.R.M.O.R. alarm output: turns the events that matter into a signed webhook
 * call and an MQTT message. Delivery never blocks ingestion, retries with
 * back-off, and its failures are audited, never thrown into the request path.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHmac } from "node:crypto";
import type { AuditLog } from "./audit.js";
import type { ArmorEvent } from "./events.js";
import type { SecurityMode } from "./store.js";

export const ALERT_TOPIC = "armor/server/alert";
export type AlertMessage = {
  service: "armor-server";
  event: "alert.raised" | "alert.cleared" | "node.offline" | "node.stale" | "camera.offline" | "alarm.raised" | "automation.notify";
  at: string;
  mode: SecurityMode;
  node_id?: string;
  camera_id?: string;
  targets?: number;
  /** For a device or a solar alarm: which alarm, how serious, what, and the device (or, for solar equipment, its "node/device" path). */
  alarm_id?: string; severity?: "critical" | "high" | "warning"; code?: string; device_id?: string; solar_id?: string;
  /** For an automation that notifies: which one, and the alarm or device that set it off when there is one. */
  automation?: string;
};

/**
 * Which events are worth waking someone for: a node reaching "high" (and
 * clearing), and a node that goes offline or silent while the system is armed
 * (a dead sensor is how a perimeter is defeated), and a camera that stops
 * answering while armed.
 */
export function alertMessageFor(event: ArmorEvent, mode: SecurityMode): AlertMessage | null {
  const base = { service: "armor-server" as const, at: event.at, mode };
  if (event.type === "alert") {
    if (event.to === "high") return { ...base, event: "alert.raised", node_id: event.node_id, targets: event.targets };
    if (event.from === "high") return { ...base, event: "alert.cleared", node_id: event.node_id, targets: event.targets };
  }
  if (event.type === "node" && mode === "armed") {
    if (event.to === "offline") return { ...base, event: "node.offline", node_id: event.node_id };
    if (event.to === "stale") return { ...base, event: "node.stale", node_id: event.node_id };
  }
  if (event.type === "camera" && mode === "armed" && event.to === "offline") return { ...base, event: "camera.offline", camera_id: event.camera_id };
  // Nodes and cameras already have their own messages above; a device alarm (smoke, a door, a flood...) is announced here.
  if (event.type === "alarm" && event.state === "raised" && event.source_type === "device") return { ...base, event: "alarm.raised", alarm_id: event.alarm_id, severity: event.severity, code: event.code, device_id: event.source };
  // Solar equipment: an inverter fault, a battery that is low or protecting itself, or equipment that went silent (the alarm centre raises each once until it clears).
  if (event.type === "alarm" && event.state === "raised" && event.source_type === "solar") return { ...base, event: "alarm.raised", alarm_id: event.alarm_id, severity: event.severity, code: event.code, solar_id: event.source };
  return null;
}

export const signBody = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export type NotifierOptions = {
  webhookUrl?: string;
  webhookSecret?: string;
  audit: AuditLog;
  fetchImpl?: typeof fetch;
  /** Waits before each retry; the number of entries is the number of retries. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
};

const MAX_QUEUE = 100;

export class AlertNotifier {
  readonly #options: NotifierOptions;
  readonly #fetch: typeof fetch;
  readonly #delays: number[];
  #publish: ((topic: string, payload: string) => void) | undefined;
  readonly #queue: AlertMessage[] = [];
  #running = false;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: NotifierOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#delays = options.retryDelaysMs ?? [1_000, 4_000, 15_000];
  }

  /** Connect the MQTT output once the broker client exists. */
  setPublisher(publish: (topic: string, payload: string) => void): void { this.#publish = publish; }

  get enabled(): boolean { return Boolean(this.#options.webhookUrl || this.#publish); }

  notify(event: ArmorEvent, mode: SecurityMode): void {
    const message = alertMessageFor(event, mode);
    if (message) this.send(message);
  }

  /** Send a message to the MQTT alarm topic and the webhook (used by automations as well). */
  send(message: AlertMessage): void {
    if (this.#closed) return;
    try { this.#publish?.(ALERT_TOPIC, JSON.stringify(message)); } catch { /* MQTT down: the webhook still goes out. */ }
    if (!this.#options.webhookUrl) return;
    if (this.#queue.length >= MAX_QUEUE) {
      this.#queue.shift();
      this.#options.audit.record({ action: "alert.webhook", outcome: "failed", detail: "queue full, oldest message dropped" });
    }
    this.#queue.push(message);
    void this.#drain();
  }

  /** Resolves when everything queued has been attempted (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#running || this.#queue.length > 0) await new Promise(resolve => setTimeout(resolve, 5));
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#queue.length = 0;
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let message = this.#queue.shift(); message && !this.#closed; message = this.#queue.shift()) await this.#deliver(message);
    } finally { this.#running = false; }
  }

  async #deliver(message: AlertMessage): Promise<void> {
    const { webhookUrl, webhookSecret, audit } = this.#options;
    if (!webhookUrl) return;
    const body = JSON.stringify(message);
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "armor-server" };
    if (webhookSecret) headers["X-Armor-Signature"] = signBody(webhookSecret, body);
    let detail = "no attempt";
    for (let attempt = 0; attempt <= this.#delays.length; attempt += 1) {
      if (this.#closed) return;
      try {
        const response = await this.#fetch(webhookUrl, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(this.#options.timeoutMs ?? 5_000) });
        if (response.ok) { audit.record({ action: "alert.webhook", outcome: "allowed", target: message.event }); return; }
        detail = `HTTP ${response.status}`;
        // A client error will not get better by retrying; a server error or rate limit might.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (error) {
        detail = error instanceof Error ? error.name : "network error";
      }
      if (attempt < this.#delays.length) await new Promise<void>(resolve => { this.#timer = setTimeout(resolve, this.#delays[attempt]); this.#timer.unref(); });
    }
    audit.record({ action: "alert.webhook", outcome: "failed", target: message.event, detail });
  }
}
