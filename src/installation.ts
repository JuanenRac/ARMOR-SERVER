/**
 * The whole installation as one file, to keep or to move to another machine: the cameras (without their passwords), the designs of the site, the electricity and the network,
 * the rules, the automations, the devices, the solar equipment that was declared and the levels of the energy alarms; and, for the record, who the users are (names and roles,
 * never a password: they are not imported, an administrator makes them again).
 *
 * Nothing secret is ever in the file: no camera password, no device credential, no token, no user's password hash. Importing is deliberately careful: the designs, the rules and
 * the alarm levels REPLACE what is there (the designs keep their versions, so a mistake is one version away from being undone), and everything that is a list of things with an
 * identifier (cameras, automations, devices, solar equipment) ADDS only what is missing and leaves what exists exactly as it is. A part that is not asked for is not touched, and a
 * part that does not check out is reported and skipped without spoiling the others.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { cameraPublic, parseCameraInput, type CameraConnection } from "./cameras/model.js";
import type { AppContext } from "./context.js";
import { parseRules } from "./rules.js";
import { SiteConflict, SiteInvalid } from "./site.js";

export const INSTALLATION_FORMAT = "armor-installation";
export const INSTALLATION_VERSION = 1;
export const PARTS = ["cameras", "site", "electrical", "network", "alarm_design", "rules", "automations", "devices", "solar_devices", "energy_alarms", "users"] as const;
export type Part = (typeof PARTS)[number];

export type InstallationBundle = {
  format: typeof INSTALLATION_FORMAT;
  version: number;
  exported_at: string;
  exported_by: string;
  parts: Partial<Record<Part, unknown>>;
};

export type ImportReport = {
  /** For each part that was applied: what happened to it, in words a person can read. */
  applied: Partial<Record<Part, string>>;
  /** Parts asked for that the file does not hold, or that are only kept for the record. */
  skipped: Partial<Record<Part, string>>;
  /** Parts that did not check out: the reason, and nothing of the part was applied. */
  failed: Partial<Record<Part, string>>;
  /** The cameras that were added and need their username and password typed in (the file never holds them). */
  cameras_need_credentials: string[];
};

const MAX_BUNDLE_PARTS_BYTES = 8 * 1024 * 1024;

function stripSecrets<T extends Record<string, unknown>>(value: T, keys: readonly string[]): T {
  const copy: Record<string, unknown> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as T;
}

/** The installation as it is now. `by` is the administrator who asked. */
export function buildBundle(context: AppContext, by: string): InstallationBundle {
  const ffmpeg = false;   // whether live video is available is not part of what is kept
  const parts: Partial<Record<Part, unknown>> = {
    cameras: context.vault.list().map(camera => {
      const { hasCredentials: _has, liveVideoAvailable: _live, ...rest } = cameraPublic(camera, ffmpeg);
      return rest;   // the username is kept (it is not a secret to the person who set it up); the password is not in the public view
    }),
    site: context.site.get().site,
    electrical: context.electrical.get().site,
    network: context.network.get().site,
    alarm_design: context.alarmDesign.get().site,
    rules: context.rules.get(),
    automations: context.automations.list().map(automation => stripSecrets(automation as unknown as Record<string, unknown>, ["last_run", "runs", "created_at"])),
    devices: context.devices.list().map(device => stripSecrets(device as unknown as Record<string, unknown>, ["state", "online", "last_seen", "created_at"])),
    solar_devices: context.solarRegistry.list(),
    energy_alarms: context.energyAlarms.get(),
    users: context.users.list().map(user => ({ username: user.username, role: user.role })),
  };
  return { format: INSTALLATION_FORMAT, version: INSTALLATION_VERSION, exported_at: new Date().toISOString(), exported_by: by.slice(0, 60), parts };
}

/** Whether `value` is a bundle this server can read (the shape only: each part is checked when it is applied). */
export function parseBundle(value: unknown): InstallationBundle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== INSTALLATION_FORMAT || typeof bundle.version !== "number" || bundle.version < 1 || bundle.version > INSTALLATION_VERSION) return null;
  if (typeof bundle.parts !== "object" || bundle.parts === null || Array.isArray(bundle.parts)) return null;
  if (JSON.stringify(bundle.parts).length > MAX_BUNDLE_PARTS_BYTES) return null;
  return {
    format: INSTALLATION_FORMAT, version: bundle.version, exported_at: typeof bundle.exported_at === "string" ? bundle.exported_at : "", exported_by: typeof bundle.exported_by === "string" ? bundle.exported_by : "",
    parts: bundle.parts as Partial<Record<Part, unknown>>,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Applies the parts of `bundle` that were asked for (all of them when `wanted` is empty). */
export function applyBundle(context: AppContext, bundle: InstallationBundle, wanted: readonly string[], by: string): ImportReport {
  const report: ImportReport = { applied: {}, skipped: {}, failed: {}, cameras_need_credentials: [] };
  const chosen = new Set<Part>(wanted.length > 0 ? PARTS.filter(part => wanted.includes(part)) : PARTS);
  for (const part of PARTS) {
    if (!chosen.has(part)) continue;
    const content = bundle.parts[part];
    if (content === undefined || content === null) { if (wanted.length > 0 || part !== "site") report.skipped[part] = wanted.length > 0 ? "the file holds none" : "the file holds none"; continue; }
    try {
      switch (part) {
        case "cameras": {
          if (!Array.isArray(content)) throw new Error("not a list");
          let added = 0, kept = 0, invalid = 0;
          for (const item of content) {
            if (!isRecord(item)) { invalid += 1; continue; }
            const existing = typeof item.id === "string" ? context.vault.get(item.id) : undefined;
            if (existing) { kept += 1; continue; }
            // the form of a new camera: everything the file says, with no password (so no username either: a username needs its password)
            const parsed: CameraConnection | null = parseCameraInput({ ...item, username: "", password: "" });
            if (!parsed) { invalid += 1; continue; }
            context.vault.save(parsed);
            report.cameras_need_credentials.push(parsed.id);
            added += 1;
          }
          report.applied.cameras = `${added} added, ${kept} already there${invalid ? `, ${invalid} refused` : ""}`;
          break;
        }
        case "site": case "electrical": case "network": case "alarm_design": {
          const store = part === "alarm_design" ? context.alarmDesign : context[part];
          if (!isRecord(content)) throw new Error("not a design");
          try { const saved = store.save(content, store.get().revision, `import by ${by}`); report.applied[part] = `replaced (revision ${saved.revision}; the previous one is kept as a version)`; }
          catch (error) {
            if (error instanceof SiteConflict) throw new Error("it changed while importing: try again");
            if (error instanceof SiteInvalid) throw new Error(error.message);
            throw error;
          }
          break;
        }
        case "rules": {
          const parsed = parseRules(content);
          if (!parsed) throw new Error("not valid rules");
          context.rules.set(parsed);
          context.store.sweep();
          report.applied.rules = `replaced (${parsed.zones.length} zones)`;
          break;
        }
        case "automations": {
          if (!Array.isArray(content)) throw new Error("not a list");
          let added = 0, kept = 0, invalid = 0;
          const have = new Set(context.automations.list().map(item => item.id));
          for (const item of content) {
            if (!isRecord(item) || typeof item.id !== "string") { invalid += 1; continue; }
            if (have.has(item.id)) { kept += 1; continue; }
            try { context.automations.create(item as Parameters<typeof context.automations.create>[0]); added += 1; } catch { invalid += 1; }
          }
          report.applied.automations = `${added} added, ${kept} already there${invalid ? `, ${invalid} refused` : ""}`;
          break;
        }
        case "devices": {
          if (!Array.isArray(content)) throw new Error("not a list");
          let added = 0, kept = 0, invalid = 0;
          const have = new Set(context.devices.list().map(item => item.id));
          for (const item of content) {
            if (!isRecord(item) || typeof item.id !== "string") { invalid += 1; continue; }
            if (have.has(item.id)) { kept += 1; continue; }
            try { context.devices.create(item as Parameters<typeof context.devices.create>[0]); added += 1; } catch { invalid += 1; }
          }
          report.applied.devices = `${added} added, ${kept} already there${invalid ? `, ${invalid} refused` : ""}`;
          break;
        }
        case "solar_devices": {
          if (!Array.isArray(content)) throw new Error("not a list");
          let added = 0, kept = 0, invalid = 0;
          const have = new Set(context.solarRegistry.list().map(item => `${item.node_id}/${item.device}`));
          for (const item of content) {
            if (!isRecord(item) || typeof item.node_id !== "string" || typeof item.device !== "string") { invalid += 1; continue; }
            if (have.has(`${item.node_id}/${item.device}`)) { kept += 1; continue; }
            try { context.solarRegistry.save(item); added += 1; } catch { invalid += 1; }
          }
          report.applied.solar_devices = `${added} added, ${kept} already there${invalid ? `, ${invalid} refused` : ""}`;
          break;
        }
        case "energy_alarms": {
          context.energyAlarms.set(content);
          report.applied.energy_alarms = "replaced";
          break;
        }
        case "users": report.skipped.users = "kept for the record: users are not imported (an administrator makes them again, with their own passwords)"; break;
      }
    } catch (error) {
      report.failed[part] = error instanceof Error ? error.message : "it could not be applied";
    }
  }
  return report;
}
