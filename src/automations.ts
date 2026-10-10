/**
 * Automations: "when this happens, do that". A trigger is a device reaching a state, an alarm being raised, or the system being armed
 * or disarmed; it may be limited to one mode; its actions switch a device on or off (optionally for a while, then back) or send the
 * alarm notification. An automation can run at most a few times a minute, so a flapping sensor cannot make a light strobe or flood a phone.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { Alarm } from "./alarms.js";
import type { DeviceChange } from "./devices/registry.js";
import type { Severity } from "./devices/catalog.js";
import type { SecurityMode } from "./store.js";

export type Trigger =
  | { type: "device"; device_id: string; field: string; equals: boolean | number }
  | { type: "alarm"; severity?: Severity; source_type?: "node" | "camera" | "device" | "solar" | "electrical" | "network" | "alarm"; source_id?: string }
  | { type: "mode"; mode: SecurityMode };
export type Action = { type: "device"; device_id: string; command: "on" | "off" | "toggle"; /** Switch back after this many seconds. */ for_s?: number } | { type: "notify" };
export type Automation = {
  id: string; name: string; enabled: boolean; trigger: Trigger; when_mode: "any" | SecurityMode; actions: Action[];
  created_at: string; last_run: string | null; runs: number;
};
export type AutomationInput = Partial<Pick<Automation, "name" | "enabled" | "trigger" | "when_mode" | "actions">>;

export const MAX_AUTOMATIONS = 100, MAX_ACTIONS = 6, MAX_FOR_S = 3600, MAX_RUNS_PER_MINUTE = 6;
const AUTOMATION_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SEVERITIES: readonly string[] = ["critical", "high", "warning"];
const FIELD = /^[a-z_]{2,20}$/;
const ID = /^[A-Za-z0-9._-]{1,80}$/;

export class AutomationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

function cleanTrigger(raw: unknown): Trigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.type === "device") {
    if (typeof t.device_id !== "string" || !ID.test(t.device_id)) throw new AutomationError("invalid_trigger", "the trigger needs a device");
    if (typeof t.field !== "string" || !FIELD.test(t.field)) throw new AutomationError("invalid_trigger", "the trigger needs a field");
    if (typeof t.equals !== "boolean" && !(typeof t.equals === "number" && Number.isFinite(t.equals))) throw new AutomationError("invalid_trigger", "the trigger needs a value to wait for");
    return { type: "device", device_id: t.device_id, field: t.field, equals: t.equals };
  }
  if (t.type === "alarm") {
    const trigger: Trigger = { type: "alarm" };
    if (t.severity !== undefined && t.severity !== "") { if (!SEVERITIES.includes(t.severity as string)) throw new AutomationError("invalid_trigger", "unknown severity"); trigger.severity = t.severity as Severity; }
    if (t.source_type !== undefined && t.source_type !== "") { if (!["node", "camera", "device", "solar", "electrical", "network", "alarm"].includes(t.source_type as string)) throw new AutomationError("invalid_trigger", "unknown source"); trigger.source_type = t.source_type as "node" | "camera" | "device" | "solar" | "electrical"; }
    if (typeof t.source_id === "string" && t.source_id) { if (!ID.test(t.source_id)) throw new AutomationError("invalid_trigger", "invalid source id"); trigger.source_id = t.source_id; }
    return trigger;
  }
  if (t.type === "mode" && (t.mode === "armed" || t.mode === "disarmed")) return { type: "mode", mode: t.mode };
  throw new AutomationError("invalid_trigger", "unknown kind of trigger");
}

function cleanActions(raw: unknown): Action[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AutomationError("invalid_actions", "an automation needs at least one action");
  if (raw.length > MAX_ACTIONS) throw new AutomationError("invalid_actions", `at most ${MAX_ACTIONS} actions`);
  return raw.map(item => {
    const a = (item ?? {}) as Record<string, unknown>;
    if (a.type === "notify") return { type: "notify" } as Action;
    if (a.type === "device" && typeof a.device_id === "string" && ID.test(a.device_id) && (a.command === "on" || a.command === "off" || a.command === "toggle")) {
      const forS = typeof a.for_s === "number" && Number.isFinite(a.for_s) ? Math.min(MAX_FOR_S, Math.max(0, Math.round(a.for_s))) : 0;
      return { type: "device", device_id: a.device_id, command: a.command, ...(forS > 0 && a.command !== "toggle" ? { for_s: forS } : {}) } as Action;
    }
    throw new AutomationError("invalid_actions", "an action is not valid");
  });
}

export type AutomationOptions = {
  file: string;
  now?: () => Date;
  mode: () => SecurityMode;
  /** Runs one action. Rejections are caught and reported through `onResult`. */
  run: (action: Action, automation: Automation) => Promise<void>;
  onResult?: (automation: Automation, action: Action, ok: boolean, detail?: string) => void;
  warn?: (message: string) => void;
};

export class AutomationEngine {
  readonly #options: AutomationOptions;
  readonly #now: () => Date;
  #automations = new Map<string, Automation>();
  readonly #recent = new Map<string, number[]>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(options: AutomationOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { automations?: unknown };
      for (const item of Array.isArray(raw.automations) ? raw.automations.slice(0, MAX_AUTOMATIONS) : []) {
        try {
          const a = item as Automation;
          if (typeof a.id !== "string" || !AUTOMATION_ID.test(a.id)) continue;
          this.#automations.set(a.id, { id: a.id, name: String(a.name ?? a.id).slice(0, 80), enabled: a.enabled !== false, trigger: cleanTrigger(a.trigger), when_mode: a.when_mode === "armed" || a.when_mode === "disarmed" ? a.when_mode : "any", actions: cleanActions(a.actions), created_at: String(a.created_at ?? this.#now().toISOString()), last_run: typeof a.last_run === "string" ? a.last_run : null, runs: Number.isInteger(a.runs) ? a.runs : 0 });
        } catch { /* skip a damaged entry */ }
      }
    } catch { /* none yet */ }
  }

  #save(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = undefined; this.flush(); }, 500);
    this.#saveTimer.unref();
  }

  flush(): void {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = undefined; }
    try {
      fs.mkdirSync(path.dirname(this.#options.file), { recursive: true });
      const temporary = `${this.#options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, automations: [...this.#automations.values()] }, null, 1), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.#options.file);
    } catch (error) { this.#options.warn?.(`the automations file could not be written: ${(error as Error).message}`); }
  }

  close(): void { for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear(); this.flush(); }

  list(): Automation[] { return [...this.#automations.values()]; }
  get(id: string): Automation | undefined { return this.#automations.get(id); }

  create(input: AutomationInput & { id?: string }): Automation {
    if (this.#automations.size >= MAX_AUTOMATIONS) throw new AutomationError("too_many", `at most ${MAX_AUTOMATIONS} automations`, 409);
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
    if (!name) throw new AutomationError("invalid_name", "an automation needs a name");
    let id = input.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!AUTOMATION_ID.test(id)) id = `auto-${Date.now()}`;
    for (let index = 2; this.#automations.has(id) && index < 1000; index += 1) id = `${id.replace(/-\d+$/, "")}-${index}`;
    const automation: Automation = {
      id, name, enabled: input.enabled !== false, trigger: cleanTrigger(input.trigger), when_mode: input.when_mode === "armed" || input.when_mode === "disarmed" ? input.when_mode : "any",
      actions: cleanActions(input.actions), created_at: this.#now().toISOString(), last_run: null, runs: 0,
    };
    this.#automations.set(id, automation);
    this.#save();
    return automation;
  }

  update(id: string, input: AutomationInput): Automation {
    const current = this.#automations.get(id);
    if (!current) throw new AutomationError("not_found", "no such automation", 404);
    const next: Automation = {
      ...current,
      ...(input.name !== undefined ? { name: (typeof input.name === "string" ? input.name.trim().slice(0, 80) : "") || current.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.trigger !== undefined ? { trigger: cleanTrigger(input.trigger) } : {}),
      ...(input.when_mode !== undefined ? { when_mode: input.when_mode === "armed" || input.when_mode === "disarmed" ? input.when_mode : "any" } : {}),
      ...(input.actions !== undefined ? { actions: cleanActions(input.actions) } : {}),
    };
    this.#automations.set(id, next);
    this.#save();
    return next;
  }

  remove(id: string): void {
    if (!this.#automations.delete(id)) throw new AutomationError("not_found", "no such automation", 404);
    this.#save();
  }

  #allowed(automation: Automation): boolean {
    const now = this.#now().getTime(), recent = (this.#recent.get(automation.id) ?? []).filter(time => now - time < 60_000);
    if (recent.length >= MAX_RUNS_PER_MINUTE) { this.#recent.set(automation.id, recent); return false; }
    recent.push(now);
    this.#recent.set(automation.id, recent);
    return true;
  }

  /** Run an automation now (for a test from Studio), regardless of its trigger, but not of the rate limit. */
  async runNow(id: string): Promise<void> {
    const automation = this.#automations.get(id);
    if (!automation) throw new AutomationError("not_found", "no such automation", 404);
    await this.#execute(automation);
  }

  async #execute(automation: Automation): Promise<void> {
    if (!this.#allowed(automation)) { this.#options.onResult?.(automation, automation.actions[0], false, "rate limited"); return; }
    automation.last_run = this.#now().toISOString();
    automation.runs += 1;
    this.#save();
    for (const action of automation.actions) {
      try {
        await this.#options.run(action, automation);
        this.#options.onResult?.(automation, action, true);
        if (action.type === "device" && action.for_s) {
          const revert: Action = { type: "device", device_id: action.device_id, command: action.command === "on" ? "off" : "on" };
          const timer = setTimeout(() => { this.#timers.delete(timer); void this.#options.run(revert, automation).then(() => this.#options.onResult?.(automation, revert, true), (error: Error) => this.#options.onResult?.(automation, revert, false, error.message)); }, action.for_s * 1000);
          timer.unref();
          this.#timers.add(timer);
        }
      } catch (error) { this.#options.onResult?.(automation, action, false, error instanceof Error ? error.message : "failed"); }
    }
  }

  #fire(match: (automation: Automation) => boolean): void {
    const mode = this.#options.mode();
    for (const automation of this.#automations.values()) {
      if (!automation.enabled || (automation.when_mode !== "any" && automation.when_mode !== mode) || !match(automation)) continue;
      void this.#execute(automation);
    }
  }

  handleDevice(change: DeviceChange): void {
    for (const item of change.changes) {
      this.#fire(a => a.trigger.type === "device" && a.trigger.device_id === change.device.id && a.trigger.field === item.field && a.trigger.equals === item.to);
    }
  }
  handleAlarm(alarm: Alarm): void {
    this.#fire(a => a.trigger.type === "alarm" && (!a.trigger.severity || a.trigger.severity === alarm.severity) && (!a.trigger.source_type || a.trigger.source_type === alarm.source.type) && (!a.trigger.source_id || a.trigger.source_id === alarm.source.id));
  }
  handleMode(mode: SecurityMode): void { this.#fire(a => a.trigger.type === "mode" && a.trigger.mode === mode); }
}
