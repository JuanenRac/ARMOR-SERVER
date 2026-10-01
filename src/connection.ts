/**
 * Where the server listens and where Studio is served, as an administrator sets it from Studio: kept in `connection.json` beside the other data, read when the server starts
 * (so a change needs a restart) and winning over the environment for the address and the ports only. A file that cannot be read or makes no sense is ignored, never fatal:
 * a wrong value typed in a page must not leave the server unable to start.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type Connection = { host?: string; port?: number; studio_port?: number };
export const CONNECTION_FILE = "connection.json";

const HOST = /^((\d{1,3}\.){3}\d{1,3}|localhost)$/;
const validPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
const validHost = (value: unknown): value is string => typeof value === "string" && HOST.test(value) && (value === "localhost" || value.split(".").every(part => Number(part) <= 255));

/** What is acceptable of a proposed setting, and why not when it is not: an empty field means "leave it as the deployment has it". */
export function checkConnection(input: unknown): { ok: true; value: Connection } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "an object is expected" };
  const raw = input as Record<string, unknown>, value: Connection = {};
  if (raw.host !== undefined && raw.host !== null && raw.host !== "") { if (!validHost(raw.host)) return { ok: false, error: "host must be an IPv4 address or localhost" }; value.host = raw.host; }
  for (const key of ["port", "studio_port"] as const) {
    const item = raw[key];
    if (item === undefined || item === null || item === "") continue;
    if (!validPort(item)) return { ok: false, error: `${key} must be a whole number from 1 to 65535` };
    value[key] = item;
  }
  if (value.port !== undefined && value.port === value.studio_port) return { ok: false, error: "the server and Studio cannot use the same port" };
  return { ok: true, value };
}

export function readConnection(dataDir: string): Connection {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, CONNECTION_FILE), "utf8")) as unknown;
    const checked = checkConnection(parsed);
    return checked.ok ? checked.value : {};
  } catch { return {}; }
}

export function writeConnection(dataDir: string, value: Connection): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, CONNECTION_FILE), temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** The origins Studio may be reached from once its port was changed: the same hosts the deployment names, on the new port. */
export function originsWithStudioPort(origins: readonly string[], studioPort: number | undefined): string[] {
  if (studioPort === undefined) return [...origins];
  const out = new Set(origins);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") continue;
      url.port = String(studioPort);
      out.add(url.origin);
    } catch { /* not an origin */ }
  }
  return [...out];
}
