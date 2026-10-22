/**
 * Who connects to the server, and what happens to the system, for the history: the clients (a Studio session, the Android app, the panel of a node, the voice service, anything else) with when each was
 * first and last seen, and the events of both kinds ("connection" and "system" in events.ts). It never holds a password, a token, a cookie, a PIN or a recovery code: a client is described by its kind,
 * the user it signed in as, the version it says it is, and (for administrators only) its address and user agent.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";
import type { ArmorEvent, ArmorEventBody, ClientKind, ConnectionAction, SystemAction, SystemCategory } from "./events.js";
import type { HeaderSource } from "./http/auth.js";

export const CLIENT_KINDS: readonly ClientKind[] = ["studio", "android", "node", "voice", "other"];
export const SYSTEM_CATEGORIES: readonly SystemCategory[] = ["node", "broker", "settings", "service", "update", "alarm", "backup", "batteries"];

/** The name a client gives itself: `X-Armor-Client: android/0.6.6`. Only informative (anybody can write it), so it never gives a client more rights. */
const CLIENT_HEADER = /^(studio|android|voice|node)\/([0-9A-Za-z._-]{1,24})$/;
const VERSION = /^[0-9A-Za-z._-]{1,24}$/;

export type Sighting = {
  kind: ClientKind;
  user?: string;
  version?: string;
  agent?: string;
  ip?: string;
  origin?: "local" | "remote";
  twoFactor?: boolean;
  /** For the panel of a node: which node. */
  label?: string;
};

/** Control characters out, a bound on the length. */
const clean = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text === "" ? undefined : text;
};

/** The coarse family of a user agent (browser and system, or the application name), so that an update of the browser is not "another device". */
export function agentFamily(agent: string | undefined): string {
  const text = agent ?? "";
  const browser = /Edg\//.test(text) ? "edge" : /OPR\/|Opera/.test(text) ? "opera" : /Firefox\//.test(text) ? "firefox" : /Chrome\/|CriOS\//.test(text) ? "chrome" : /Safari\//.test(text) ? "safari" : "";
  const system = /Windows/.test(text) ? "windows" : /Android/.test(text) ? "android" : /iPhone|iPad|iOS/.test(text) ? "ios" : /Mac OS X|Macintosh/.test(text) ? "mac" : /Linux|X11/.test(text) ? "linux" : "";
  if (browser) return `${browser}/${system}`;
  return (text.split(/[\s/]/)[0] ?? "").toLowerCase().slice(0, 24);
}

/** Whether a session opened with this user agent belongs to the client (the same family of agent). */
export const agentMatches = (record: { agent?: string }, sessionAgent: string): boolean => agentFamily(record.agent) === agentFamily(sessionAgent);

/** What kind of client a request comes from: what it says (`X-Armor-Client`), else what its user agent shows. */
export function identify(request: HeaderSource): Pick<Sighting, "kind" | "version" | "agent"> {
  const agent = clean(request.header("user-agent"), 120);
  const said = CLIENT_HEADER.exec(request.header("x-armor-client") ?? "");
  if (said) return { kind: said[1] as ClientKind, version: said[2], agent };
  const text = agent ?? "";
  const app = /^ARMOR-ANDROID-CONTROL\/([0-9A-Za-z._-]{1,24})/.exec(text);
  if (app) return { kind: "android", version: app[1], agent };
  if (/^ARMOR-VOICE/i.test(text)) return { kind: "voice", agent };
  if (/^armor-(radar|solar|electrical|alarm|hmi)/i.test(text)) return { kind: "node", agent };
  if (/Dalvik|okhttp/i.test(text)) return { kind: "android", agent };
  return { kind: "other", agent };
}

/** The identifier of a client: a hash of its kind, the user and the family of its agent. Not a secret, and it cannot be turned back into the user agent. */
export function clientIdOf(sighting: Pick<Sighting, "kind" | "user" | "agent" | "label">): string {
  return createHash("sha256").update(`${sighting.kind}|${(sighting.user ?? "").toLowerCase()}|${sighting.label ?? ""}|${agentFamily(sighting.agent)}`).digest("hex").slice(0, 16);
}

export type ClientRecord = {
  id: string; kind: ClientKind; user?: string; label?: string; app_version?: string; origin?: "local" | "remote"; two_factor?: boolean;
  first_seen: number; last_seen: number; last_failure?: number; logins_ok: number; logins_failed: number; ip?: string; agent?: string;
};
export type ClientView = Omit<ClientRecord, "first_seen" | "last_seen" | "last_failure" | "ip" | "agent"> & { first_seen: string; last_seen: string; last_failure?: string; active_sessions: number; ip?: string; agent?: string };

const CAPACITY = 300;
const FORGET_AFTER_MS = 120 * 86_400_000;
const SAVE_EVERY_MS = 30_000;
const TOUCH_EVERY_MS = 30_000;

export type RegistryOptions = { file: string; now?: () => number; capacity?: number };

/** The clients the server has seen, bounded, kept in a file so a restart does not forget them. */
export class ClientRegistry {
  readonly #file: string;
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #clients = new Map<string, ClientRecord>();
  #lastSave = 0;
  #dirty = false;

  constructor(options: RegistryOptions) {
    this.#file = options.file;
    this.#now = options.now ?? Date.now;
    this.#capacity = options.capacity ?? CAPACITY;
    try {
      const saved = JSON.parse(fs.readFileSync(this.#file, "utf8")) as { clients?: unknown };
      const cutoff = this.#now() - FORGET_AFTER_MS;
      for (const item of Array.isArray(saved.clients) ? saved.clients.slice(0, this.#capacity) : []) {
        const record = ClientRegistry.#parse(item);
        if (record && record.last_seen >= cutoff) this.#clients.set(record.id, record);
      }
    } catch { /* nothing remembered yet */ }
  }

  static #parse(item: unknown): ClientRecord | undefined {
    if (typeof item !== "object" || item === null) return undefined;
    const r = item as Record<string, unknown>;
    const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
    if (typeof r.id !== "string" || !/^[0-9a-f]{16}$/.test(r.id) || typeof r.kind !== "string" || !(CLIENT_KINDS as readonly string[]).includes(r.kind)) return undefined;
    const first = number(r.first_seen), last = number(r.last_seen);
    if (first === undefined || last === undefined) return undefined;
    const text = (value: unknown, max: number): string | undefined => (typeof value === "string" ? clean(value, max) : undefined);
    const version = typeof r.app_version === "string" && VERSION.test(r.app_version) ? r.app_version : undefined;
    return {
      id: r.id, kind: r.kind as ClientKind, first_seen: first, last_seen: last, logins_ok: Math.trunc(number(r.logins_ok) ?? 0), logins_failed: Math.trunc(number(r.logins_failed) ?? 0),
      ...(text(r.user, 60) ? { user: text(r.user, 60) } : {}), ...(text(r.label, 80) ? { label: text(r.label, 80) } : {}), ...(version ? { app_version: version } : {}),
      ...(r.origin === "local" || r.origin === "remote" ? { origin: r.origin } : {}), ...(typeof r.two_factor === "boolean" ? { two_factor: r.two_factor } : {}),
      ...(number(r.last_failure) !== undefined ? { last_failure: number(r.last_failure) } : {}), ...(text(r.ip, 64) ? { ip: text(r.ip, 64) } : {}), ...(text(r.agent, 120) ? { agent: text(r.agent, 120) } : {}),
    };
  }

  /** The client is seen now (a new one is made). `isNew` is true the first time; `quiet` is true when it was seen a moment ago and nothing about it changed. */
  touch(sighting: Sighting, change: { ok?: boolean; failed?: boolean } = {}): { record: ClientRecord; isNew: boolean; quiet: boolean } {
    const now = this.#now();
    const id = clientIdOf(sighting);
    let record = this.#clients.get(id);
    const isNew = record === undefined;
    if (!record) {
      if (this.#clients.size >= this.#capacity) this.#evict();
      record = { id, kind: sighting.kind, first_seen: now, last_seen: now, logins_ok: 0, logins_failed: 0 };
      this.#clients.set(id, record);
    }
    const quiet = !isNew && !change.ok && !change.failed && now - record.last_seen < TOUCH_EVERY_MS
      && (sighting.ip === undefined || sighting.ip === record.ip) && (sighting.version === undefined || sighting.version === record.app_version);
    if (quiet) return { record, isNew, quiet };
    record.last_seen = now;
    const user = clean(sighting.user, 60), label = clean(sighting.label, 80), ip = clean(sighting.ip, 64), agent = clean(sighting.agent, 120);
    if (user) record.user = user;
    if (label) record.label = label;
    if (ip) record.ip = ip;
    if (agent) record.agent = agent;
    if (sighting.version && VERSION.test(sighting.version)) record.app_version = sighting.version;
    if (sighting.origin) record.origin = sighting.origin;
    if (sighting.twoFactor !== undefined) record.two_factor = sighting.twoFactor;
    if (change.ok) record.logins_ok += 1;
    if (change.failed) { record.logins_failed += 1; record.last_failure = now; }
    this.#dirty = true;
    if (now - this.#lastSave >= SAVE_EVERY_MS) this.flush();
    return { record, isNew, quiet };
  }

  /** The least recently seen client goes when the table is full, so a flood of different clients cannot grow it without limit. */
  #evict(): void {
    let oldest: ClientRecord | undefined;
    for (const record of this.#clients.values()) if (!oldest || record.last_seen < oldest.last_seen) oldest = record;
    if (oldest) this.#clients.delete(oldest.id);
  }

  /** Newest first; `active` is told by the caller (the sessions are in the session store). */
  list(sessions: (record: ClientRecord) => number, admin: boolean, filter: { kind?: ClientKind; user?: string; active?: boolean } = {}): ClientView[] {
    const wanted = filter.user?.toLowerCase();
    return [...this.#clients.values()]
      .filter(record => (!filter.kind || record.kind === filter.kind) && (!wanted || record.user?.toLowerCase() === wanted))
      .map(record => ({ record, active: sessions(record) }))
      .filter(item => !filter.active || item.active > 0)
      .sort((a, b) => b.record.last_seen - a.record.last_seen)
      .map(({ record, active }) => {
        const { first_seen, last_seen, last_failure, ip, agent, ...rest } = record;
        return {
          ...rest, first_seen: new Date(first_seen).toISOString(), last_seen: new Date(last_seen).toISOString(), active_sessions: active,
          ...(last_failure !== undefined ? { last_failure: new Date(last_failure).toISOString() } : {}), ...(admin && ip ? { ip } : {}), ...(admin && agent ? { agent } : {}),
        };
      });
  }

  /** Written when something changed and the last write was a while ago (called often by the server). */
  tick(): void { if (this.#dirty && this.#now() - this.#lastSave >= SAVE_EVERY_MS) this.flush(); }

  flush(): void {
    this.#lastSave = this.#now();
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, clients: [...this.#clients.values()] }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#file);
    } catch { this.#dirty = true; /* the history of connections is a convenience: it never breaks the request it describes */ }
  }
}

export type EventSink = (body: ArmorEventBody) => ArmorEvent;

/** Writes the connection events and keeps the registry of the clients. */
export class ConnectionTracker {
  constructor(readonly registry: ClientRegistry, private readonly sink: EventSink) {}

  #write(sighting: Sighting, action: ConnectionAction, extra: { two_factor?: boolean; subject?: string } = {}): void {
    const { record } = this.registry.touch(sighting, { ok: action === "login", failed: action === "login_failed" || action === "second_factor_failed" });
    const user = clean(sighting.user, 60), ip = clean(sighting.ip, 64), agent = clean(sighting.agent, 120);
    this.sink({
      type: "connection", action, client_kind: record.kind, client_id: record.id, ...(user ? { user } : {}), ...(sighting.origin ? { origin: sighting.origin } : {}),
      ...(extra.two_factor !== undefined ? { two_factor: extra.two_factor } : {}), ...(sighting.version && VERSION.test(sighting.version) ? { app_version: sighting.version } : {}),
      ...(extra.subject ? { subject: clean(extra.subject, 80) } : {}), ...(ip ? { ip } : {}), ...(agent ? { agent } : {}),
    });
  }

  /** A sign-in worked. */
  login(sighting: Sighting, twoFactor: boolean): void { this.#write({ ...sighting, twoFactor }, "login", { two_factor: twoFactor }); }

  /**
   * A sign-in was refused. The name that was typed is kept only when it is the name of a real account: a person who types the password in the user box, or a stranger who guesses, leaves nothing
   * of what they typed in the history.
   */
  refused(sighting: Sighting, action: "login_failed" | "second_factor_failed", knownUser: boolean): void {
    this.#write(knownUser ? sighting : { ...sighting, user: undefined }, action);
  }

  /** A session of a person ended: they signed out, they or an administrator ended it, or its time ran out. */
  ended(sighting: Sighting, action: "logout" | "session_ended" | "session_expired"): void { this.#write(sighting, action); }

  /** A person opened the panel of a node through the server. */
  panelOpened(sighting: Sighting, node: string): void { this.#write({ ...sighting, kind: "node", label: node }, "panel_opened", { subject: node }); }

  /** The client made a request: it is remembered, and the first time a client is seen without signing in (a service with a token) one event says so. */
  seen(sighting: Sighting): void {
    const { isNew, quiet, record } = this.registry.touch(sighting);
    if (isNew && !quiet) {
      this.sink({ type: "connection", action: "first_seen", client_kind: record.kind, client_id: record.id, ...(record.user ? { user: record.user } : {}), ...(record.app_version ? { app_version: record.app_version } : {}), ...(record.ip ? { ip: record.ip } : {}), ...(record.agent ? { agent: record.agent } : {}) });
    }
  }
}

// ---- the events of the system -----------------------------------------------------------------------------------------------------------

const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:,/-]{0,79}$/;
const SAFE_NAME = /^[A-Za-z0-9._@-]{1,60}$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const SAFE_PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type SystemInput = { category: SystemCategory; action: SystemAction; subject?: string; by?: string; version?: string; previous_version?: string; profile?: string; outcome?: "allowed" | "denied" | "failed" };

/** A system event whose every field has been checked: a field that does not look like what it should is left out, never written as it came. */
export function systemBody(input: SystemInput): Extract<ArmorEventBody, { type: "system" }> {
  return {
    type: "system", category: input.category, action: input.action,
    ...(input.subject && SAFE_SUBJECT.test(input.subject) ? { subject: input.subject } : {}), ...(input.by && SAFE_NAME.test(input.by) ? { by: input.by } : {}),
    ...(input.version && SAFE_VERSION.test(input.version) ? { version: input.version } : {}), ...(input.previous_version && SAFE_VERSION.test(input.previous_version) ? { previous_version: input.previous_version } : {}),
    ...(input.profile && SAFE_PROFILE.test(input.profile) ? { profile: input.profile } : {}), ...(input.outcome ? { outcome: input.outcome } : {}),
  };
}

type Life = { present: boolean; firmware?: string };

/** Which nodes are there, to say when one appears, comes back, changes firmware or disappears; kept in a file so a restart of the server does not make every node "appear" again. */
export class NodeLife {
  readonly #file: string;
  readonly #nodes = new Map<string, Life>();
  #dirty = false;
  constructor(file: string, private readonly sink: (input: SystemInput) => void) {
    this.#file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes?: Record<string, { present?: unknown; firmware?: unknown }> };
      for (const [id, item] of Object.entries(saved.nodes ?? {}).slice(0, 256)) {
        if (!SAFE_SUBJECT.test(id) || typeof item !== "object" || item === null) continue;
        this.#nodes.set(id, { present: item.present === true, ...(typeof item.firmware === "string" && SAFE_VERSION.test(item.firmware) ? { firmware: item.firmware } : {}) });
      }
    } catch { /* nothing remembered yet */ }
  }

  /** The node spoke (a health report carries its firmware). */
  report(id: string, firmware?: string): void {
    if (!SAFE_SUBJECT.test(id)) return;
    const known = this.#nodes.get(id);
    if (!known) {
      if (this.#nodes.size >= 256) return;
      this.#nodes.set(id, { present: true, ...(firmware ? { firmware } : {}) });
      this.#dirty = true;
      this.sink({ category: "node", action: "appeared", subject: id, version: firmware });
    } else {
      if (!known.present) { known.present = true; this.#dirty = true; this.sink({ category: "node", action: "returned", subject: id, version: firmware ?? known.firmware }); }
      if (firmware && known.firmware && known.firmware !== firmware) { this.#dirty = true; this.sink({ category: "node", action: "firmware_changed", subject: id, version: firmware, previous_version: known.firmware }); }
      if (firmware && known.firmware !== firmware) { known.firmware = firmware; this.#dirty = true; }
    }
  }

  /** The node went quiet or offline. */
  gone(id: string): void {
    const known = this.#nodes.get(id);
    if (!known || !known.present) return;
    known.present = false;
    this.#dirty = true;
    this.sink({ category: "node", action: "disappeared", subject: id, version: known.firmware });
  }

  flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, nodes: Object.fromEntries(this.#nodes) }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#file);
    } catch { this.#dirty = true; }
  }
}

// ---- what the audit trail says, in the vocabulary of the history ---------------------------------------------------------------------------

const SETTINGS: Record<string, { action: SystemAction; area: string }> = {
  "rules.update": { action: "changed", area: "rules" }, "camera.configure": { action: "changed", area: "camera" }, "camera.remove": { action: "removed", area: "camera" },
  "camera.ignore_zones": { action: "changed", area: "ignore_zones" }, "device.create": { action: "created", area: "device" }, "device.update": { action: "changed", area: "device" }, "device.delete": { action: "removed", area: "device" },
  "automation.create": { action: "created", area: "automation" }, "automation.update": { action: "changed", area: "automation" }, "automation.delete": { action: "removed", area: "automation" },
  "network.save": { action: "changed", area: "network_design" }, "electrical.save": { action: "changed", area: "electrical_design" }, "alarm_design.save": { action: "changed", area: "alarm_design" },
  "alarm_profiles.save": { action: "changed", area: "arming_profiles" }, "admin.mqtt.add": { action: "created", area: "mqtt_account" }, "admin.mqtt.remove": { action: "removed", area: "mqtt_account" },
  "admin.node.configure": { action: "changed", area: "node" }, "admin.node.provision": { action: "created", area: "node_account" }, "admin.installation.import": { action: "changed", area: "installation" },
  "admin.node-panel.set": { action: "changed", area: "node_panel" }, "admin.node-panel.remove": { action: "removed", area: "node_panel" }, "admin.node-panel.trust": { action: "changed", area: "node_panel" },
  "remote.policy": { action: "changed", area: "remote_access" }, "remote.vpn.setup": { action: "changed", area: "vpn" }, "remote.vpn.peer.add": { action: "created", area: "vpn_peer" }, "remote.vpn.peer.remove": { action: "removed", area: "vpn_peer" },
  "remote.ddns.setup": { action: "changed", area: "ddns" }, "user.create": { action: "created", area: "user" }, "user.update": { action: "changed", area: "user" }, "user.delete": { action: "removed", area: "user" },
  "users.totp.reset": { action: "changed", area: "second_factor" }, "evidence.auto_capture.settings": { action: "changed", area: "auto_capture" }, "solar.create": { action: "created", area: "solar_device" }, "solar.delete": { action: "removed", area: "solar_device" },
  "solar.alarms": { action: "changed", area: "solar_alarms" }, "node.remove": { action: "removed", area: "node" }, "history.delete": { action: "removed", area: "history" }, "network.device.forget": { action: "removed", area: "network_device" },
};
const SERVICE_VERBS: Record<string, SystemAction> = { start: "started", stop: "stopped", restart: "restarted" };

export type AuditLike = { action: string; outcome: "allowed" | "denied" | "failed"; actor?: string; target?: string; detail?: string };

/**
 * What an audit entry means for the history of the system, or nothing. Only the words of this table and the checked name of the person and of the thing reach the history: the free text of the audit
 * entry (its detail) is read here for a few known shapes and never copied. A disarm under duress is never written: it is told only to the places nobody at the panel can see.
 */
export function systemFromAudit(entry: AuditLike): SystemInput | undefined {
  const by = entry.actor, outcome = entry.outcome;
  const detail = entry.detail ?? "";
  if (/duress/i.test(detail)) return undefined;
  const target = entry.target && SAFE_SUBJECT.test(entry.target) ? entry.target : undefined;
  if (entry.action === "battery.execute" && outcome === "allowed") return { category: "batteries", action: "battery_requested", by, subject: target, outcome };
  if (entry.action === "battery.result" && (outcome === "allowed" || outcome === "failed")) return { category: "batteries", action: "battery_operation", by, subject: target, outcome };
  if (entry.action === "control.arm" && outcome === "allowed") return { category: "alarm", action: "armed", by };
  if (entry.action === "control.disarm" && outcome === "allowed") return { category: "alarm", action: "disarmed", by };
  if (entry.action === "alarm.acknowledge" && outcome === "allowed") return { category: "alarm", action: "acknowledged", by, subject: target };
  if (entry.action === "alarm.command" && outcome === "allowed") {
    const shape = /^(arm|disarm|silence)(?: (?:away|stay))?(?: profile ([a-z0-9][a-z0-9_-]{0,31}))?(?: forced)?: sent/.exec(detail);
    if (!shape) return undefined;
    return { category: "alarm", action: shape[1] === "arm" ? "arm_requested" : shape[1] === "disarm" ? "disarm_requested" : "silence_requested", by, subject: target, profile: shape[2] };
  }
  if (entry.action === "admin.service") {
    const verb = SERVICE_VERBS[detail];
    return verb ? { category: "service", action: verb, by, subject: target, outcome } : undefined;
  }
  if (entry.action === "diagnostics.token_issue" && outcome === "allowed") return { category: "settings", action: "diagnostic_token_issued", by, subject: target, outcome };
  if (entry.action === "diagnostics.token_revoke" && outcome === "allowed") return { category: "settings", action: "diagnostic_token_revoked", by, subject: target, outcome };
  if (entry.action === "diagnostics.token_use" && outcome === "allowed") return { category: "settings", action: "diagnostic_token_used", subject: target, outcome };
  if (entry.action === "diagnostics.token_denied") return { category: "settings", action: "diagnostic_token_denied", subject: target, outcome: "denied" };
  if (entry.action === "maintenance.update") return { category: "update", action: "installed", by, subject: target, outcome };
  if (entry.action === "maintenance.rollback") return { category: "update", action: "rolled_back", by, subject: target, outcome };
  if (entry.action === "maintenance.check") return { category: "update", action: "checked", by, outcome };
  const setting = SETTINGS[entry.action];
  if (setting) return { category: "settings", action: setting.action, by, subject: target ? `${setting.area}:${target}`.slice(0, 80) : setting.area, outcome };
  return undefined;
}

