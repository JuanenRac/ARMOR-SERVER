/**
 * A.R.M.O.R. audit trail: one JSON line per security-relevant action, written
 * to the data directory and to the console. Never records a secret, a camera
 * password, a token or a stream URL.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type AuditEvent = {
  action: string;
  outcome: "allowed" | "denied" | "failed";
  actor?: string;
  target?: string;
  detail?: string;
};

export type AuditLog = { record(event: AuditEvent): void };

const MAX_BYTES = 5 * 1024 * 1024;
const KEPT_FILES = 3;

/** Remove anything that looks like credentials from free text before it is stored. */
export function scrub(text: string): string {
  return text
    .replace(/rtsp:\/\/[^\s@/]+@/gi, "rtsp://***@")
    .replace(/(password|token|secret|authorization)(["'\s:=]+)[^\s"',;]+/gi, "$1$2***")
    .slice(0, 300);
}

export function createAuditLog(dataDir: string, sink: (line: string) => void = line => console.info(line), now: () => Date = () => new Date()): AuditLog {
  const file = path.join(dataDir, "audit.log");
  const rotate = (): void => {
    try {
      if (fs.statSync(file).size < MAX_BYTES) return;
      for (let index = KEPT_FILES - 1; index >= 1; index -= 1) {
        if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    } catch { /* No log yet, or rotation raced: the next write retries. */ }
  };
  return {
    record(event) {
      const entry = {
        at: now().toISOString(), action: event.action, outcome: event.outcome,
        ...(event.actor ? { actor: scrub(event.actor) } : {}),
        ...(event.target ? { target: scrub(event.target) } : {}),
        ...(event.detail ? { detail: scrub(event.detail) } : {}),
      };
      const line = JSON.stringify(entry);
      sink(`ARMOR_AUDIT ${line}`);
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        rotate();
        fs.appendFileSync(file, line + "\n", { encoding: "utf8", mode: 0o600 });
      } catch { /* Auditing must never break the request it describes. */ }
    },
  };
}
