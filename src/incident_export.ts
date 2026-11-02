/**
 * The record of one incident as a single signed document, for an insurer, the police or a lawyer: the events of the history in a window of time, the lines of the audit trail in the
 * same window and the evidence files made in it (camera, name, size, time and SHA-256, never the picture itself), signed with the same key as a proof of custody. Anyone who has the
 * server can ask whether the document is genuine and whether a file still has the digest it lists. Read only; it holds no password, token or camera login, and the audit lines are the
 * ones the server keeps (who did what, never the content of a request).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_WINDOW_MS = 7 * 24 * 3_600_000;
export const MAX_EVENTS = 5000;
export const MAX_AUDIT = 5000;
export const MAX_FILES = 200;

export type IncidentFile = { camera: string; kind: string; name: string; bytes: number; created_at: string; sha256: string | null; protected: boolean };
export type Incident = {
  version: 1;
  issued_at: string;
  issuer: "armor-server";
  window: { from: string; to: string };
  events: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  files: IncidentFile[];
  /** What was left out for being past a limit, so a reader knows the lists are not the whole story. */
  truncated: { events: boolean; audit: boolean; files: boolean };
  /** Whether the audit trail still reaches back to the start of the window (older lines are rotated away). */
  audit_complete: boolean;
  signature: { algorithm: "HMAC-SHA256"; value: string };
};

const key = (secret: string): Buffer => createHash("sha256").update(`armor-incident-export|${secret}`).digest();

/** A stable text of the document without its signature: keys sorted at every level, so the same content always signs the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(name => record[name] !== undefined).sort().map(name => `${JSON.stringify(name)}:${canonical(record[name])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The window asked for: two ISO times, from before to, no longer than a week. Undefined when it is not one. */
export function parseWindow(from: unknown, to: unknown): { fromMs: number; toMs: number } | undefined {
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > MAX_WINDOW_MS) return undefined;
  return { fromMs, toMs };
}

/** The lines of the audit trail inside the window, oldest first, from the current file and the rotated ones; `from` is the time of the oldest line kept at all. */
export function auditBetween(dataDir: string, fromMs: number, toMs: number, cap = MAX_AUDIT): { lines: Array<Record<string, unknown>>; from: string | null; truncated: boolean } {
  const lines: Array<Record<string, unknown>> = [];
  let oldest: string | null = null, truncated = false;
  for (const name of ["audit.log.3", "audit.log.2", "audit.log.1", "audit.log"]) {
    let text: string;
    try { text = fs.readFileSync(path.join(dataDir, name), "utf8"); } catch { continue; }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (typeof parsed.at !== "string") continue;
      if (oldest === null) oldest = parsed.at;
      const time = Date.parse(parsed.at);
      if (time < fromMs || time > toMs) continue;
      if (lines.length >= cap) { truncated = true; continue; }
      lines.push(parsed);
    }
  }
  return { lines, from: oldest, truncated };
}

export function buildIncident(secret: string, input: {
  fromMs: number; toMs: number; events: Array<Record<string, unknown>>; eventsTruncated: boolean; audit: ReturnType<typeof auditBetween>; files: IncidentFile[]; filesTruncated: boolean; issuedAt?: Date;
}): Incident {
  const body: Omit<Incident, "signature"> = {
    version: 1, issued_at: (input.issuedAt ?? new Date()).toISOString(), issuer: "armor-server",
    window: { from: new Date(input.fromMs).toISOString(), to: new Date(input.toMs).toISOString() },
    events: input.events, audit: input.audit.lines, files: input.files,
    truncated: { events: input.eventsTruncated, audit: input.audit.truncated, files: input.filesTruncated },
    audit_complete: input.audit.from !== null && Date.parse(input.audit.from) <= input.fromMs,
  };
  return { ...body, signature: { algorithm: "HMAC-SHA256", value: createHmac("sha256", key(secret)).update(canonical(body)).digest("hex") } };
}

/** Whether the document is exactly what this server signed (any of the keys still known). */
export function verifyIncident(secrets: readonly string[], value: unknown): value is Incident {
  if (typeof value !== "object" || value === null) return false;
  const incident = value as Incident;
  if (incident.version !== 1 || incident.issuer !== "armor-server" || typeof incident.signature?.value !== "string" || !/^[0-9a-f]{64}$/.test(incident.signature.value)) return false;
  if (!Array.isArray(incident.events) || !Array.isArray(incident.audit) || !Array.isArray(incident.files)) return false;
  const { signature, ...body } = incident;
  const given = Buffer.from(signature.value, "hex");
  for (const candidate of secrets) {
    const expected = createHmac("sha256", key(candidate)).update(canonical(body)).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
