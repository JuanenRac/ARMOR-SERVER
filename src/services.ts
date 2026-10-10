/**
 * The services of the A.R.M.O.R. system, running or not: the programs of the machine (the server, Studio, the MQTT broker, the network node, the AI and voice services when they
 * are installed), read from systemd, and the field nodes (radars, electrical nodes, the network node's own reports), read from what they last said. Studio draws them as a list by
 * family, like HYDRA-UMC's services menu. The list itself only reads: starting, stopping, restarting and pausing go through the administration routes. Where there is no systemd (a development machine) the programs are shown
 * as "unknown" and the field nodes are still listed.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type ServiceState = "running" | "paused" | "stopped" | "failed" | "starting" | "not_installed" | "online" | "offline" | "unknown";
export type ServiceView = {
  id: string;
  name: string;
  family: string;
  description: string;
  kind: "systemd" | "field-node";
  state: ServiceState;
  /** systemd's own words for the state (running, dead, failed, exited...), when there is one. */
  sub_state?: string;
  /** The systemd unit, when the service is a program of this machine. */
  unit?: string;
  enabled?: boolean | null;
  pid?: number | null;
  /** When the service started (ms since 1970), or when a field node last reported. */
  since_ms?: number | null;
  memory_bytes?: number | null;
  restarts?: number | null;
  port?: number | null;
  /** The version of the program (or the firmware of a field node), when it can be told; absent when it cannot. */
  version?: string | null;
};

export type CatalogEntry = { id: string; name: string; family: string; description: string; unit: string; port?: number };

/** What the system is made of on its core machine. A program that is not installed is listed as such, so the list shows the whole system. */
export const CATALOG: readonly CatalogEntry[] = [
  { id: "server", name: "ARMOR-SERVER", family: "Core", description: "Central state, alarms, users, cameras, evidence and the API", unit: "armor-server.service", port: 18080 },
  { id: "studio", name: "ARMOR-STUDIO", family: "Core", description: "The web console", unit: "armor-studio.service", port: 18081 },
  { id: "broker", name: "MQTT broker", family: "Core", description: "Where the field nodes publish what they read", unit: "armor-mosquitto.service", port: 18883 },
  { id: "network", name: "ARMOR-NETWORK", family: "Network", description: "Watches the local network: devices, internet and what changes", unit: "armor-network.service" },
  { id: "server-ai", name: "ARMOR-SERVER-AI", family: "AI and voice", description: "Decides what a camera detection means (day and night, movement first)", unit: "armor-server-ai.service" },
  { id: "voice-ai", name: "ARMOR-VOICE-AI", family: "AI and voice", description: "Written and spoken commands (a closed list of fifteen commands, arm and disarm confirmed in two turns)", unit: "armor-voice.service", port: 18090 },
];

const PROPERTIES = ["Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "ActiveEnterTimestampMonotonic", "ExecMainStartTimestamp", "MemoryCurrent", "NRestarts", "ExecStart", "WorkingDirectory", "Environment"] as const;

export type UnitInfo = Record<string, string>;

/** `systemctl show` for several units: blocks of Key=Value lines, one block per unit, separated by a blank line. */
export function parseSystemctlShow(text: string): Map<string, UnitInfo> {
  const units = new Map<string, UnitInfo>();
  for (const block of text.split(/\n\s*\n/)) {
    const info: UnitInfo = {};
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) info[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    if (info.Id) units.set(info.Id, info);
  }
  return units;
}

/** A systemd timestamp such as "Wed 2026-10-01 14:41:48 UTC" (or empty) as ms since 1970. */
export function parseSystemdTime(text: string | undefined): number | null {
  if (!text) return null;
  const match = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+(\w+))?/.exec(text);
  if (!match) return null;
  const zone = match[3] && /^(UTC|GMT)$/i.test(match[3]) ? "Z" : "";
  const value = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(value) ? value : null;
}

const numberOrNull = (text: string | undefined): number | null => {
  if (text === undefined || text === "" || /^\[?not set\]?$/i.test(text) || /^18446744073709551615$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** The state a person understands, from systemd's load, active and sub states. */
export function stateOf(info: UnitInfo | undefined): ServiceState {
  if (!info) return "unknown";
  if (info.LoadState === "not-found") return "not_installed";
  switch (info.ActiveState) {
    case "active": return info.SubState === "exited" ? "stopped" : "running";
    case "activating": case "reloading": return "starting";
    case "failed": return "failed";
    case "inactive": case "deactivating": return "stopped";
    default: return "unknown";
  }
}

/** True when the process is frozen by a signal (state T in /proc/<pid>/stat): systemd still calls such a service active, Studio calls it paused. */
export type PausedReader = (pid: number) => boolean;
export const procPausedReader: PausedReader = pid => {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return false;
  try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); return text[text.lastIndexOf(")") + 2] === "T"; } catch { return false; }
};

export function serviceFromUnit(entry: CatalogEntry, info: UnitInfo | undefined, paused: PausedReader = () => false): ServiceView {
  const view: ServiceView = { id: entry.id, name: entry.name, family: entry.family, description: entry.description, kind: "systemd", state: stateOf(info), unit: entry.unit };
  if (entry.port !== undefined) view.port = entry.port;
  if (!info || info.LoadState === "not-found") return view;
  view.sub_state = info.SubState || undefined;
  const flag = info.UnitFileState;
  view.enabled = flag ? ["enabled", "enabled-runtime", "static", "alias", "linked"].includes(flag) : null;
  view.pid = numberOrNull(info.MainPID) || null;
  if (view.state === "running" && view.pid && paused(view.pid)) view.state = "paused";
  view.since_ms = view.state === "running" || view.state === "starting" ? parseSystemdTime(info.ExecMainStartTimestamp) : null;
  view.memory_bytes = numberOrNull(info.MemoryCurrent);
  view.restarts = numberOrNull(info.NRestarts);
  return view;
}

export type UnitReader = (units: readonly string[]) => Promise<string | null>;

/** The real reader: `systemctl show`, which any user may run. Null where there is no systemd. */
export const systemctlReader: UnitReader = units => new Promise(resolve => {
  if (process.platform !== "linux") return resolve(null);
  execFile("systemctl", ["show", `--property=${PROPERTIES.join(",")}`, ...units], { timeout: 4000, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error && !stdout ? null : stdout));
});

export type FieldNode = { id: string; kind: string; online: boolean; last_ms: number | null; firmware?: string | null };

export function fieldNodeView(node: FieldNode): ServiceView {
  const state: ServiceState = node.online ? "online" : "offline";
  const view: ServiceView = { id: `node:${node.kind}:${node.id}`, name: node.id, family: "Field nodes", description: node.kind, kind: "field-node", state, since_ms: node.last_ms };
  if (node.firmware) view.version = node.firmware;
  return view;
}

// ---- the version of each program ---------------------------------------------------------------------------------------------------------------

/** Tells the version of a program of this machine, or null when it cannot. It never throws. */
export type VersionReader = (entry: CatalogEntry, info: UnitInfo | undefined) => Promise<string | null>;

const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

/** The program and its arguments from systemd's `ExecStart` property: `{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -m armor_voice_ai.service --port 1 ; ignore_errors=no ; ... }`. */
export function execOf(text: string | undefined): { program: string; args: string[] } | null {
  const argv = /argv\[\]=(.*?)\s;\s/.exec(text ?? "");
  if (!argv?.[1]) return null;
  const words = argv[1].trim().split(/\s+/);
  return words[0] ? { program: words[0], args: words.slice(1) } : null;
}

/** The directories a Python program is found in: its PYTHONPATH, then its working directory and the `src` under it. */
export function pythonDirs(info: UnitInfo): string[] {
  const dirs: string[] = [];
  for (const assignment of (info.Environment ?? "").split(/\s+/)) if (assignment.startsWith("PYTHONPATH=")) dirs.push(...assignment.slice(11).split(":").filter(Boolean));
  const work = info.WorkingDirectory;
  if (work && work.startsWith("/")) dirs.push(work, path.posix.join(work, "src"));
  return dirs;
}

/** `__version__ = "0.2.3"` of a Python package's `__init__.py`. */
export function pythonPackageVersion(source: string): string | null {
  const match = /^__version__\s*=\s*["']([^"']+)["']/m.exec(source);
  return match && VERSION.test(match[1]!) ? match[1]! : null;
}

/** The first line `mosquitto -h` prints: "mosquitto version 2.0.18". */
export function mosquittoVersion(output: string): string | null {
  const match = /mosquitto version (\d+\.\d+\.\d+)/i.exec(output);
  return match ? match[1]! : null;
}

async function fetchStudioVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version.json`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === "string" && VERSION.test(body.version) ? body.version : null;
  } catch { return null; }
}

function runMosquitto(program: string): Promise<string | null> {
  return new Promise(resolve => execFile(program, ["-h"], { timeout: 3000, maxBuffer: 64 * 1024 }, (_error, stdout, stderr) => resolve(mosquittoVersion(`${stdout}\n${stderr}`))));
}

/**
 * The real reader. The server knows its own version; Studio publishes `version.json` next to its pages; the Python services carry `__version__` in their package, found
 * where systemd says the program runs; the broker says it when asked.
 */
export function programVersions(ownVersion: string): VersionReader {
  return async (entry, info) => {
    try {
      if (entry.id === "server") return ownVersion;
      if (!info || info.LoadState === "not-found") return null;
      if (entry.id === "studio") return entry.port ? await fetchStudioVersion(entry.port) : null;
      const exec = execOf(info.ExecStart);
      if (entry.id === "broker") return exec ? await runMosquitto(exec.program) : null;
      const at = exec ? exec.args.indexOf("-m") : -1;
      const module = at >= 0 ? ((exec!.args[at + 1] ?? "").split(".")[0] ?? "") : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module)) return null;
      for (const dir of pythonDirs(info)) {
        try { const found = pythonPackageVersion(readFileSync(path.posix.join(dir, module, "__init__.py"), "utf8")); if (found) return found; } catch { /* not there: the next directory */ }
      }
    } catch { /* a version that cannot be told is simply not shown */ }
    return null;
  };
}

export async function listServices(read: UnitReader, nodes: readonly FieldNode[], paused: PausedReader = procPausedReader, versions: VersionReader = async () => null): Promise<{ systemd: boolean; services: ServiceView[] }> {
  const text = await read(CATALOG.map(entry => entry.unit));
  const parsed = text === null ? null : parseSystemctlShow(text);
  const services = await Promise.all(CATALOG.map(async entry => {
    const info = parsed?.get(entry.unit);
    const view = serviceFromUnit(entry, info, paused);
    const version = await versions(entry, info);
    if (version) view.version = version;
    return view;
  }));
  return { systemd: parsed !== null, services: [...services, ...nodes.map(fieldNodeView)] };
}
