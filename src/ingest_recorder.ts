/**
 * The optional copy of what the nodes send, for playing an incident again on the bench: one JSON line per message in the form ARMOR-SIMULATOR plays with --replay
 * ({"topic","payload"} and, besides, "at" (when the server received it), "accepted" and "reason" (why it was refused)).
 * It writes only while the option ingest.recording is on (off by default), keeps the file under a size limit and rotates it (ARMOR_INGEST_RECORD_MAX_BYTES, ARMOR_INGEST_RECORD_FILES),
 * and never writes what looks like a secret: orders to the nodes are not copied at all, and a field named like a token, a key, a password or a PIN is left out of the copy.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type RecorderOptions = {
  dir: string;
  enabled: () => boolean;
  maxBytes: number;
  maxFiles: number;
  now?: () => number;
};

export type RecorderState = { enabled: boolean; file: string; bytes: number; files: number; max_bytes: number; max_files: number; lines: number; accepted: number; rejected: number; skipped: number; rotations: number; since: string | null };

const FILE = "ingest.jsonl";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_REASON = 200;
const SECRET_NAME = /token|secret|passw|passcode|pin$|^pin_|key|credential|authoriz|cookie|signature/i;
/** Orders to the nodes and maintenance traffic carry one-time tokens: they are not node traffic and are never copied. */
const NOT_RECORDED = /^armor\/(control\/|solar\/[^/]+\/maintenance\/)/;

/** The copy of a payload without the fields that look like a secret (at any depth). */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) if (!SECRET_NAME.test(name)) out[name] = withoutSecrets(item, depth + 1);
    return out;
  }
  return value;
}

export class IngestRecorder {
  readonly #options: RecorderOptions;
  #bytes = 0; #lines = 0; #accepted = 0; #rejected = 0; #skipped = 0; #rotations = 0; #since: string | null = null; #failed = false;
  constructor(options: RecorderOptions) {
    this.#options = options;
    try { this.#bytes = fs.statSync(this.#path(0)).size; } catch { this.#bytes = 0; }
  }

  #path(index: number): string { return path.join(this.#options.dir, index === 0 ? FILE : `ingest.${index}.jsonl`); }

  get enabled(): boolean { return this.#options.enabled(); }

  state(): RecorderState {
    let files = 0;
    for (let index = 0; index < this.#options.maxFiles; index += 1) if (fs.existsSync(this.#path(index))) files += 1;
    return { enabled: this.enabled, file: FILE, bytes: this.#bytes, files, max_bytes: this.#options.maxBytes, max_files: this.#options.maxFiles, lines: this.#lines, accepted: this.#accepted, rejected: this.#rejected, skipped: this.#skipped, rotations: this.#rotations, since: this.#since };
  }

  /** Keeps one message. Does nothing while the option is off; a message that is not a JSON object under an armor/ topic is not something the simulator can play and is counted as skipped. */
  record(topic: string, payload: string | Buffer | unknown, accepted: boolean, reason?: string): void {
    if (!this.enabled || this.#failed) return;
    if (!topic.startsWith("armor/") || NOT_RECORDED.test(topic)) return;
    let body: unknown = payload;
    if (typeof payload === "string" || Buffer.isBuffer(payload)) {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      if (text.length > MAX_MESSAGE_BYTES) { this.#skipped += 1; return; }
      try { body = JSON.parse(text); } catch { this.#skipped += 1; return; }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) { this.#skipped += 1; return; }
    const at = new Date((this.#options.now ?? Date.now)()).toISOString();
    const line: Record<string, unknown> = { topic, payload: withoutSecrets(body), at, accepted };
    if (reason) line.reason = reason.length > MAX_REASON ? reason.slice(0, MAX_REASON) : reason;
    const text = `${JSON.stringify(line)}\n`;
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_MESSAGE_BYTES * 2) { this.#skipped += 1; return; }
    try {
      fs.mkdirSync(this.#options.dir, { recursive: true, mode: 0o700 });
      if (this.#bytes > 0 && this.#bytes + size > this.#options.maxBytes) this.#rotate();
      fs.appendFileSync(this.#path(0), text, { mode: 0o600 });
      this.#bytes += size; this.#lines += 1; if (accepted) this.#accepted += 1; else this.#rejected += 1; this.#since ??= at;
    } catch (error) {
      // A disk that cannot be written must not stop the ingest: the copy stops, and the state says so by not growing.
      this.#failed = true;
      console.warn("ARMOR_INGEST_RECORDING=FAILED", error instanceof Error ? error.message : "cannot write");
    }
  }

  /** The files that exist, newest first (index 0 is the one being written), with their sizes. */
  files(): { index: number; name: string; bytes: number }[] {
    const out: { index: number; name: string; bytes: number }[] = [];
    for (let index = 0; index < this.#options.maxFiles; index += 1) {
      try { out.push({ index, name: path.basename(this.#path(index)), bytes: fs.statSync(this.#path(index)).size }); } catch { /* not there */ }
    }
    return out;
  }

  /** The path of one of the files for a download, or undefined when it does not exist. The index is a number the caller already checked; nothing of it reaches the path as text. */
  pathOf(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.#options.maxFiles) return undefined;
    const file = this.#path(index);
    return fs.existsSync(file) ? file : undefined;
  }

  /** Clears the failure (an administrator turned the option off and on again). */
  reset(): void { this.#failed = false; }

  #rotate(): void {
    const last = this.#options.maxFiles - 1;
    if (last <= 0) { fs.rmSync(this.#path(0), { force: true }); }
    else {
      fs.rmSync(this.#path(last), { force: true });
      for (let index = last - 1; index >= 0; index -= 1) if (fs.existsSync(this.#path(index))) fs.renameSync(this.#path(index), this.#path(index + 1));
    }
    this.#bytes = 0; this.#rotations += 1;
  }
}
