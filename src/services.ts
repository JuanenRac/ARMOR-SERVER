/**
 * The services of the A.R.M.O.R. system, running or not: the programs of the machine (the server, Studio, the MQTT broker, the network node, the AI and voice services when they
 * are installed), read from systemd, and the field nodes (radars, electrical nodes, the network node's own reports), read from what they last said. Studio draws them as a list by
 * family, like HYDRA-UMC's services menu. Read only: nothing here starts, stops or changes anything. Where there is no systemd (a development machine) the programs are shown
 * as "unknown" and the field nodes are still listed.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { execFile } from "node:child_process";

export type ServiceState = "running" | "stopped" | "failed" | "starting" | "not_installed" | "online" | "offline" | "unknown";
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
};

export type CatalogEntry = { id: string; name: string; family: string; description: string; unit: string; port?: number };

/** What the system is made of on its core machine. A program that is not installed is listed as such, so the list shows the whole system. */
export const CATALOG: readonly CatalogEntry[] = [
  { id: "server", name: "ARMOR-SERVER", family: "Core", description: "Central state, alarms, users, cameras, evidence and the API", unit: "armor-server.service", port: 18080 },
  { id: "studio", name: "ARMOR-STUDIO", family: "Core", description: "The web console", unit: "armor-studio.service", port: 18081 },
  { id: "broker", name: "MQTT broker", family: "Core", description: "Where the field nodes publish what they read", unit: "armor-mosquitto.service", port: 18883 },
  { id: "network", name: "ARMOR-NETWORK", family: "Network", description: "Watches the local network: devices, internet and what changes", unit: "armor-network.service" },
  { id: "server-ai", name: "ARMOR-SERVER-AI", family: "AI and voice", description: "Decides what a camera detection means (day and night, movement first)", unit: "armor-server-ai.service" },
  { id: "voice-ai", name: "ARMOR-VOICE-AI", family: "AI and voice", description: "Written and spoken commands (a closed list of four, confirmed in two turns)", unit: "armor-voice.service", port: 18090 },
];

const PROPERTIES = ["Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "ActiveEnterTimestampMonotonic", "ExecMainStartTimestamp", "MemoryCurrent", "NRestarts"] as const;

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

export function serviceFromUnit(entry: CatalogEntry, info: UnitInfo | undefined): ServiceView {
  const view: ServiceView = { id: entry.id, name: entry.name, family: entry.family, description: entry.description, kind: "systemd", state: stateOf(info), unit: entry.unit };
  if (entry.port !== undefined) view.port = entry.port;
  if (!info || info.LoadState === "not-found") return view;
  view.sub_state = info.SubState || undefined;
  const flag = info.UnitFileState;
  view.enabled = flag ? ["enabled", "enabled-runtime", "static", "alias", "linked"].includes(flag) : null;
  view.pid = numberOrNull(info.MainPID) || null;
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

export type FieldNode = { id: string; kind: string; online: boolean; last_ms: number | null };

export function fieldNodeView(node: FieldNode): ServiceView {
  const state: ServiceState = node.online ? "online" : "offline";
  return { id: `node:${node.kind}:${node.id}`, name: node.id, family: "Field nodes", description: node.kind, kind: "field-node", state, since_ms: node.last_ms };
}

export async function listServices(read: UnitReader, nodes: readonly FieldNode[]): Promise<{ systemd: boolean; services: ServiceView[] }> {
  const text = await read(CATALOG.map(entry => entry.unit));
  const parsed = text === null ? null : parseSystemctlShow(text);
  const services = CATALOG.map(entry => serviceFromUnit(entry, parsed?.get(entry.unit)));
  return { systemd: parsed !== null, services: [...services, ...nodes.map(fieldNodeView)] };
}
