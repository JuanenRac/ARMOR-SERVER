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
import { alertText, type AlertLanguage } from "./alert_text.js";
import type { NotifyChannel } from "./channels.js";

export const ALERT_TOPIC = "armor/server/alert";
export type AlertMessage = {
  service: "armor-server";
  event: "alert.raised" | "alert.cleared" | "node.offline" | "node.stale" | "camera.offline" | "alarm.raised" | "automation.notify" | "alert.test";
  at: string;
  mode: SecurityMode;
  node_id?: string;
  camera_id?: string;
  targets?: number;
  /** For a device or a solar alarm: which alarm, how serious, what, and the device (or, for solar equipment, its "node/device" path). */
  alarm_id?: string; severity?: "critical" | "high" | "warning"; code?: string; device_id?: string; solar_id?: string; electrical_id?: string;
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
  // A camera that saw movement (the observation service): told with the camera; "camera_down" has its own message above.
  if (event.type === "alarm" && event.state === "raised" && event.source_type === "camera" && event.code === "camera_motion") return { ...base, event: "alarm.raised", alarm_id: event.alarm_id, severity: event.severity, code: event.code, camera_id: event.source };
  if (event.type === "alarm" && event.state === "raised" && event.source_type === "solar") return { ...base, event: "alarm.raised", alarm_id: event.alarm_id, severity: event.severity, code: event.code, solar_id: event.source };
  // An electrical node: a meter's alarm, the mains out of range, the grid lost or a node that went silent.
  if (event.type === "alarm" && event.state === "raised" && event.source_type === "electrical") return { ...base, event: "alarm.raised", alarm_id: event.alarm_id, severity: event.severity, code: event.code, electrical_id: event.source };
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
  /** Other places the alarms go (Telegram, Home Assistant), and the language their sentences are told in. */
  channels?: NotifyChannel[];
  language?: AlertLanguage;
};

/** What a test of one place came to. */
export type ChannelTest = { channel: string; ok: boolean; detail: string };

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

  get enabled(): boolean { return Boolean(this.#options.webhookUrl || this.#publish || this.#channels.length > 0); }

  get #channels(): NotifyChannel[] { return this.#options.channels ?? []; }
  get #language(): AlertLanguage { return this.#options.language ?? "es"; }

  /** Which places the alarms are sent to (nothing secret). */
  status(): { webhook: boolean; mqtt: boolean; telegram: boolean; homeassistant: boolean; language: AlertLanguage } {
    return { webhook: Boolean(this.#options.webhookUrl), mqtt: Boolean(this.#publish), telegram: this.#channels.some(channel => channel.id === "telegram"), homeassistant: this.#channels.some(channel => channel.id === "homeassistant"), language: this.#language };
  }

  /** Sends one test message to every place (or to the one asked for), once and at once, and says what each came to. */
  async test(mode: SecurityMode, only?: string): Promise<ChannelTest[]> {
    const message: AlertMessage = { service: "armor-server", event: "alert.test", at: new Date().toISOString(), mode };
    const text = alertText(message, this.#language);
    const results: ChannelTest[] = [];
    if ((!only || only === "webhook") && this.#options.webhookUrl) { const attempt = await this.#postWebhook(message); results.push({ channel: "webhook", ok: attempt.ok, detail: attempt.detail }); }
    if ((!only || only === "mqtt") && this.#publish) {
      try { this.#publish(ALERT_TOPIC, JSON.stringify(message)); results.push({ channel: "mqtt", ok: true, detail: ALERT_TOPIC }); } catch { results.push({ channel: "mqtt", ok: false, detail: "the broker did not take it" }); }
    }
    for (const channel of this.#channels) {
      if (only && only !== channel.id) continue;
      const attempt = await channel.deliver(message, text, this.#language, AbortSignal.timeout(this.#options.timeoutMs ?? 5_000));
      results.push({ channel: channel.id, ok: attempt.ok, detail: attempt.detail });
    }
    this.#options.audit.record({ action: "alert.test", outcome: results.length > 0 && results.every(item => item.ok) ? "allowed" : "failed", detail: results.map(item => `${item.channel}:${item.ok ? "ok" : item.detail}`).join(" ") || "no place configured" });
    return results;
  }

  notify(event: ArmorEvent, mode: SecurityMode): void {
    const message = alertMessageFor(event, mode);
    if (message) this.send(message);
  }

  /** Send a message to the MQTT alarm topic and the webhook (used by automations as well). */
  send(message: AlertMessage): void {
    if (this.#closed) return;
    try { this.#publish?.(ALERT_TOPIC, JSON.stringify(message)); } catch { /* MQTT down: the webhook still goes out. */ }
    if (!this.#options.webhookUrl && this.#channels.length === 0) return;
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

  async #postWebhook(message: AlertMessage): Promise<{ ok: boolean; detail: string; final?: boolean }> {
    const { webhookUrl, webhookSecret } = this.#options;
    const body = JSON.stringify(message);
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "armor-server" };
    if (webhookSecret) headers["X-Armor-Signature"] = signBody(webhookSecret, body);
    try {
      const response = await this.#fetch(webhookUrl as string, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(this.#options.timeoutMs ?? 5_000) });
      if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
      // A client error will not get better by retrying; a server error or rate limit might.
      return { ok: false, detail: `HTTP ${response.status}`, final: response.status >= 400 && response.status < 500 && response.status !== 429 };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.name : "network error" }; }
  }

  /** Tries until it is delivered, a client error says it never will be, or the retries are spent; every end is in the audit trail. */
  async #withRetries(action: string, message: AlertMessage, attemptOnce: () => Promise<{ ok: boolean; detail: string; final?: boolean }>): Promise<void> {
    let detail = "no attempt";
    for (let attempt = 0; attempt <= this.#delays.length; attempt += 1) {
      if (this.#closed) return;
      const result = await attemptOnce();
      if (result.ok) { this.#options.audit.record({ action, outcome: "allowed", target: message.event }); return; }
      detail = result.detail;
      if (result.final) break;
      if (attempt < this.#delays.length) await new Promise<void>(resolve => { this.#timer = setTimeout(resolve, this.#delays[attempt]); this.#timer.unref(); });
    }
    this.#options.audit.record({ action, outcome: "failed", target: message.event, detail });
  }

  async #deliver(message: AlertMessage): Promise<void> {
    if (this.#options.webhookUrl) await this.#withRetries("alert.webhook", message, () => this.#postWebhook(message));
    const text = alertText(message, this.#language);
    for (const channel of this.#channels) {
      await this.#withRetries(`alert.${channel.id}`, message, () => channel.deliver(message, text, this.#language, AbortSignal.timeout(this.#options.timeoutMs ?? 5_000)));
    }
  }
}
