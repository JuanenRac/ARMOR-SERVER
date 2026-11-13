/**
 * Scheduled, encrypted backups of the data directory of the server, from the console. It is behind a security option (`admin.backup`, off by default: the routes answer 403 and nothing
 * is scheduled). An administrator sets, in Studio, whether a backup is made by itself and how often, how many are kept, where they go (a folder of this machine, or a USB drive or a network
 * share that the machine has mounted: S3 is not supported) and the passphrase that encrypts them.
 *
 * A backup is one file, `armor-backup-<time>.armorbk`: the eight bytes `ARMORBK1`, the 16-byte salt, the 12-byte IV and the 16-byte tag of AES-256-GCM, then the ciphertext of a gzip
 * of `<4-byte length><manifest JSON><the files one after the other>`. The manifest lists every file with its path, size and SHA-256. The key is scrypt(passphrase, salt): the server keeps
 * the derived key (and not the passphrase) in `backup-key.json`, mode 0600, so that a backup can be made on schedule; whoever knows the passphrase can open a backup without this server.
 * What is left out: the backups themselves, the temporary files, and the pictures and recordings (`include_media`, off by default). A backup is proved, not trusted: `verify` decrypts it,
 * checks every hash and writes the files into a temporary folder, which it removes, so that a restore is known to work before it is needed.
 *
 * The settings file `backup.json` also holds `allowed_roots` (the places a destination may be under; /media, /mnt and /run/media at first): it can only be changed by editing the file, never
 * from the console. A destination outside them, or one with `..` in it, is refused. With `require_mount` (the default) the destination must be on another device than the data
 * directory, so that a USB drive that was not plugged in does not fill the disk of the machine.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { gunzip, gzip } from "node:zlib";
import { durableRename } from "./durable.js";

const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip);

export class BackupError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 422 | 500 | 503 = 400) { super(message); }
}

export const MAGIC = Buffer.from("ARMORBK1");
export const FILE_NAME = /^armor-backup-\d{8}T\d{6}Z\.armorbk$/;
export const EVERY_H = { min: 1, max: 720, default: 24 } as const;
export const KEEP = { min: 1, max: 60, default: 7 } as const;
export const MAX_MB = { min: 1, max: 2048, default: 256 } as const;
export const MIN_PASSPHRASE = 12;
const DEFAULT_ROOTS = ["/media", "/mnt", "/run/media"];
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type BackupSettings = {
  /** Make a backup by itself every `every_h` hours. */
  schedule: boolean;
  every_h: number;
  keep: number;
  /** A folder of this machine, or under one of the allowed roots; "" is the folder `backups` inside the data directory. */
  destination: string;
  require_mount: boolean;
  include_media: boolean;
  /** The most data, in MiB, one backup may hold (it is built in memory). */
  max_mb: number;
};
export const DEFAULT_SETTINGS: BackupSettings = { schedule: false, every_h: EVERY_H.default, keep: KEEP.default, destination: "", require_mount: true, include_media: false, max_mb: MAX_MB.default };

export type BackupInfo = { name: string; bytes: number; at: string };
export type BackupResult = { ok: boolean; at: string; file?: string; bytes?: number; files?: number; error?: string };
type Manifest = { schema: 1; made_at: string; files: Array<{ path: string; size: number; sha256: string }> };

export type BackupOptions = {
  dataDir: string;
  /** `backup.json` and `backup-key.json` live here. */
  stateDir: string;
  now?: () => Date;
  /** Told when a backup is made or proved (for the history of the system). */
  onEvent?: (action: "backup_made" | "backup_restored", outcome: "allowed" | "failed", detail: string) => void;
};

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const unstamp = (name: string): string => { const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : ""; };

/** The settings as the console may give them: unknown keys, wrong types and values out of range are refused, never guessed. */
export function parseBackupSettings(value: unknown, base: BackupSettings = DEFAULT_SETTINGS): BackupSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BackupError("invalid_settings", "the settings must be an object", 422);
  const input = value as Record<string, unknown>;
  const out: BackupSettings = { ...base };
  for (const key of Object.keys(input)) if (!(key in DEFAULT_SETTINGS) && key !== "passphrase") throw new BackupError("invalid_settings", `unknown setting ${key}`, 422);
  for (const key of ["schedule", "require_mount", "include_media"] as const) if (key in input) { if (typeof input[key] !== "boolean") throw new BackupError("invalid_settings", `${key} must be true or false`, 422); out[key] = input[key] as boolean; }
  for (const [key, range] of [["every_h", EVERY_H], ["keep", KEEP], ["max_mb", MAX_MB]] as const) {
    if (!(key in input)) continue;
    const number = input[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < range.min || number > range.max) throw new BackupError("invalid_settings", `${key} must be a whole number from ${range.min} to ${range.max}`, 422);
    out[key] = number;
  }
  if ("destination" in input) {
    const destination = input.destination;
    if (typeof destination !== "string" || destination.length > 300 || destination.includes("\0") || (destination !== "" && !path.isAbsolute(destination)) || destination.split(/[\\/]/).includes("..")) throw new BackupError("invalid_settings", "the destination is empty or an absolute path without ..", 422);
    out.destination = destination;
  }
  return out;
}

export class BackupService {
  readonly #o: BackupOptions;
  readonly #now: () => Date;
  #settings: BackupSettings = { ...DEFAULT_SETTINGS };
  #roots: string[] = [...DEFAULT_ROOTS];
  #key: { salt: string; key: string } | null = null;
  #last: BackupResult | null = null;
  #lastVerify: BackupResult | null = null;
  #running = false;

  constructor(options: BackupOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    try {
      const raw = JSON.parse(fs.readFileSync(this.#settingsFile, "utf8")) as { settings?: unknown; allowed_roots?: unknown; last?: BackupResult };
      this.#settings = parseBackupSettings(raw.settings ?? {});
      if (Array.isArray(raw.allowed_roots)) this.#roots = raw.allowed_roots.filter((item): item is string => typeof item === "string" && path.isAbsolute(item));
      if (raw.last && typeof raw.last.at === "string") this.#last = raw.last;
    } catch { /* none yet, or damaged: the defaults */ }
    try {
      const raw = JSON.parse(fs.readFileSync(this.#keyFile, "utf8")) as { salt?: string; key?: string };
      if (typeof raw.salt === "string" && /^[0-9a-f]{32}$/.test(raw.salt) && typeof raw.key === "string" && /^[0-9a-f]{64}$/.test(raw.key)) this.#key = { salt: raw.salt, key: raw.key };
    } catch { /* no key yet */ }
  }

  get #settingsFile(): string { return path.join(this.#o.stateDir, "backup.json"); }
  get #keyFile(): string { return path.join(this.#o.stateDir, "backup-key.json"); }

  #writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, file);
  }
  #saveSettings(): void { this.#writeJson(this.#settingsFile, { schema: 1, settings: this.#settings, allowed_roots: this.#roots, last: this.#last }); }

  /** The folder backups are written to, checked against the allowed places. */
  destinationDir(settings: BackupSettings = this.#settings): string {
    const local = path.join(this.#o.dataDir, "backups");
    if (settings.destination === "") return local;
    const wanted = path.resolve(settings.destination);
    const under = (root: string): boolean => { const relative = path.relative(path.resolve(root), wanted); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
    if (!this.#roots.some(under) && !under(this.#o.dataDir)) throw new BackupError("destination_not_allowed", "the destination is not under one of the allowed places", 422);
    return wanted;
  }

  get settings(): BackupSettings { return { ...this.#settings }; }
  get keySet(): boolean { return this.#key !== null; }
  get running(): boolean { return this.#running; }

  /** Saves the settings; a passphrase (at least twelve characters) makes the key for the next backups. The previous backups stay readable with the passphrase that made them. */
  configure(input: unknown): BackupSettings {
    const next = parseBackupSettings(input, this.#settings);
    const passphrase = (input as Record<string, unknown>).passphrase;
    this.destinationDir(next);
    if (passphrase !== undefined) {
      if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE || passphrase.length > 200) throw new BackupError("weak_passphrase", `the passphrase has at least ${MIN_PASSPHRASE} characters`, 422);
      const salt = randomBytes(16);
      this.#key = { salt: salt.toString("hex"), key: scryptSync(passphrase, salt, 32, SCRYPT).toString("hex") };
      this.#writeJson(this.#keyFile, this.#key);
    }
    if (next.schedule && !this.#key) throw new BackupError("passphrase_needed", "a passphrase is needed before backups can be scheduled", 422);
    this.#settings = next;
    this.#saveSettings();
    return this.settings;
  }

  list(): BackupInfo[] {
    let dir: string;
    try { dir = this.destinationDir(); } catch { return []; }
    try {
      return fs.readdirSync(dir).filter(name => FILE_NAME.test(name)).sort().reverse().map(name => ({ name, bytes: fs.statSync(path.join(dir, name)).size, at: unstamp(name) }));
    } catch { return []; }
  }

  status(): { settings: BackupSettings; key_set: boolean; running: boolean; last: BackupResult | null; last_verify: BackupResult | null; backups: BackupInfo[] } {
    return { settings: this.settings, key_set: this.keySet, running: this.#running, last: this.#last, last_verify: this.#lastVerify, backups: this.list() };
  }

  async #collect(): Promise<Array<{ path: string; data: Buffer }>> {
    const root = path.resolve(this.#o.dataDir);
    const skipDirs = new Set([path.join(root, "backups")]);
    let destination: string | undefined;
    try { destination = path.resolve(this.destinationDir()); } catch { /* reported when writing */ }
    if (destination) skipDirs.add(destination);
    if (!this.#settings.include_media) for (const name of ["evidence", "media", "recordings", "snapshots"]) skipDirs.add(path.join(root, name));
    const limit = this.#settings.max_mb * 1024 * 1024;
    const files: Array<{ path: string; data: Buffer }> = [];
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!skipDirs.has(full)) await walk(full); continue; }
        if (!entry.isFile() || entry.name.endsWith(".tmp") || entry.name.endsWith(".armorbk") || (dir === root && entry.name === "backup-key.json")) continue;
        const data = await fs.promises.readFile(full);
        total += data.length;
        if (total > limit) throw new BackupError("too_large", `the data is more than ${this.#settings.max_mb} MiB`, 422);
        files.push({ path: path.relative(root, full).split(path.sep).join("/"), data });
      }
    };
    await walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Makes a backup now. Resolves with what was written; the same result is kept as the last one, also when it failed. */
  async run(by?: string): Promise<BackupResult> {
    if (this.#running) throw new BackupError("busy", "a backup is already being made", 409);
    if (!this.#key) throw new BackupError("passphrase_needed", "a passphrase is needed before a backup can be made", 422);
    this.#running = true;
    const at = this.#now();
    try {
      const dir = this.destinationDir();
      if (this.#settings.require_mount && this.#settings.destination !== "") {
        let device: number, home: number;
        try { device = fs.statSync(dir).dev; home = fs.statSync(this.#o.dataDir).dev; } catch { throw new BackupError("destination_missing", "the destination is not there", 409); }
        if (device === home) throw new BackupError("not_mounted", "the destination is on the same device as the data: is the drive mounted?", 409);
      }
      fs.mkdirSync(dir, { recursive: true });
      const files = await this.#collect();
      const manifest: Manifest = { schema: 1, made_at: at.toISOString(), files: files.map(file => ({ path: file.path, size: file.data.length, sha256: sha(file.data) })) };
      const header = Buffer.from(JSON.stringify(manifest), "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      const packed = await gzipAsync(Buffer.concat([length, header, ...files.map(file => file.data)]));
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.#key.key, "hex"), iv);
      const body = Buffer.concat([cipher.update(packed), cipher.final()]);
      const out = Buffer.concat([MAGIC, Buffer.from(this.#key.salt, "hex"), iv, cipher.getAuthTag(), body]);
      const name = `armor-backup-${stamp(at)}.armorbk`;
      const temporary = path.join(dir, `${name}.tmp`);
      fs.writeFileSync(temporary, out, { mode: 0o600 });
      durableRename(temporary, path.join(dir, name));
      this.#prune(dir);
      this.#last = { ok: true, at: at.toISOString(), file: name, bytes: out.length, files: files.length };
      this.#saveSettings();
      this.#o.onEvent?.("backup_made", "allowed", `${name}${by ? ` by ${by}` : ""}`);
      return this.#last;
    } catch (error) {
      this.#last = { ok: false, at: at.toISOString(), error: error instanceof BackupError ? error.code : "failed" };
      try { this.#saveSettings(); } catch { /* the result is still returned */ }
      this.#o.onEvent?.("backup_made", "failed", this.#last.error ?? "failed");
      throw error instanceof BackupError ? error : new BackupError("failed", error instanceof Error ? error.message : "the backup failed", 500);
    } finally { this.#running = false; }
  }

  #prune(dir: string): void {
    const names = fs.readdirSync(dir).filter(name => FILE_NAME.test(name)).sort().reverse();
    for (const name of names.slice(this.#settings.keep)) { try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* the next backup tries again */ } }
  }

  /**
   * Proves a backup: decrypts it (with the stored key, or with `passphrase` for one made under another), checks the manifest and every hash, and writes the files into a temporary folder
   * that is removed at once. Without `name` the newest is used.
   */
  async verify(name?: string, passphrase?: string): Promise<BackupResult> {
    const at = this.#now().toISOString();
    try {
      const dir = this.destinationDir();
      const chosen = name ?? this.list()[0]?.name;
      if (!chosen) throw new BackupError("no_backup", "there is no backup to prove", 404);
      if (!FILE_NAME.test(chosen)) throw new BackupError("invalid_name", "not the name of a backup", 422);
      let raw: Buffer;
      try { raw = fs.readFileSync(path.join(dir, chosen)); } catch { throw new BackupError("no_backup", "no such backup", 404); }
      const files = await this.open(raw, passphrase);
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "armor-restore-"));
      try {
        for (const file of files) {
          const target = path.join(temporary, ...file.path.split("/"));
          if (path.relative(temporary, target).startsWith("..")) throw new BackupError("corrupt", "a path in the backup leaves the folder", 422);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.data);
          if (sha(fs.readFileSync(target)) !== sha(file.data)) throw new BackupError("corrupt", "a file did not read back as it was written", 422);
        }
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      this.#lastVerify = { ok: true, at, file: chosen, bytes: raw.length, files: files.length };
      this.#o.onEvent?.("backup_restored", "allowed", `test of ${chosen}`);
    } catch (error) {
      this.#lastVerify = { ok: false, at, error: error instanceof BackupError ? error.code : "failed" };
      this.#o.onEvent?.("backup_restored", "failed", this.#lastVerify.error ?? "failed");
      if (error instanceof BackupError) throw error;
      throw new BackupError("failed", error instanceof Error ? error.message : "the test failed", 500);
    }
    return this.#lastVerify;
  }

  /** The files inside a backup, after the authentication tag and every hash have been checked. Used by `verify` and by a restore tool. */
  async open(raw: Buffer, passphrase?: string): Promise<Array<{ path: string; data: Buffer }>> {
    if (raw.length < MAGIC.length + 16 + 12 + 16 + 1 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("corrupt", "not a backup of this server", 422);
    const salt = raw.subarray(8, 24), iv = raw.subarray(24, 36), tag = raw.subarray(36, 52), body = raw.subarray(52);
    let key: Buffer;
    if (passphrase !== undefined) key = scryptSync(passphrase, salt, 32, SCRYPT);
    else if (this.#key && this.#key.salt === salt.toString("hex")) key = Buffer.from(this.#key.key, "hex");
    else throw new BackupError("wrong_key", "the stored key is not the one that made this backup: give the passphrase", 422);
    let packed: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      packed = await gunzipAsync(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch { throw new BackupError("wrong_key", "the backup cannot be opened: wrong passphrase, or it was changed", 422); }
    if (packed.length < 4) throw new BackupError("corrupt", "the backup is empty", 422);
    const headerLength = packed.readUInt32BE(0);
    if (headerLength === 0 || 4 + headerLength > packed.length) throw new BackupError("corrupt", "the manifest is cut", 422);
    let manifest: Manifest;
    try { manifest = JSON.parse(packed.subarray(4, 4 + headerLength).toString("utf8")) as Manifest; } catch { throw new BackupError("corrupt", "the manifest cannot be read", 422); }
    if (manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new BackupError("corrupt", "the manifest is not valid", 422);
    const files: Array<{ path: string; data: Buffer }> = [];
    let offset = 4 + headerLength;
    for (const item of manifest.files) {
      if (typeof item?.path !== "string" || item.path.startsWith("/") || item.path.split("/").includes("..") || !Number.isInteger(item.size) || item.size < 0 || typeof item.sha256 !== "string") throw new BackupError("corrupt", "an entry of the manifest is not valid", 422);
      const data = packed.subarray(offset, offset + item.size);
      offset += item.size;
      if (data.length !== item.size) throw new BackupError("corrupt", "the backup is cut", 422);
      const a = Buffer.from(sha(data)), b = Buffer.from(item.sha256);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BackupError("corrupt", `the hash of ${item.path} does not match`, 422);
      files.push({ path: item.path, data });
    }
    return files;
  }

  /** Once a minute: makes the backup that is due. Never throws; the result is the last one. */
  async tick(optionOn: boolean): Promise<boolean> {
    if (!optionOn || !this.#settings.schedule || this.#running || !this.#key) return false;
    const last = this.#last ? Date.parse(this.#last.at) : 0;
    if (this.#now().getTime() - last < this.#settings.every_h * 3_600_000) return false;
    try { await this.run("schedule"); return true; } catch { return false; }
  }
}
