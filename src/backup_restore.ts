/**
 * Restoring a `.armorbk` backup without the server running (tools/armorbk_restore.ts). The backup is proved first (the authentication tag of AES-256-GCM, which is the signature of the
 * file, and the SHA-256 of every file in it); a checklist says what was checked and what the person must still do; nothing is written unless `--apply` is given; and what is already in
 * the target folder is copied aside first, never overwritten without a copy. The passphrase is read from the environment or a file, never from the command line.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { BackupError, FILE_NAME, keyFromPassphrase, openWithKey } from "./backup.js";

export type RestoreStep = { name: string; ok: boolean; detail: string };
export type CheckedBackup = { steps: RestoreStep[]; files: Array<{ path: string; data: Buffer }>; ok: boolean };

const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Proves a backup: its name, its authentication tag (with the passphrase) and the hash of each file. Nothing is written. */
export async function checkBackup(file: string, passphrase: string): Promise<CheckedBackup> {
  const steps: RestoreStep[] = [];
  const add = (name: string, ok: boolean, detail: string): boolean => { steps.push({ name, ok, detail }); return ok; };
  let raw: Buffer;
  try { raw = fs.readFileSync(file); } catch { add("read", false, "the backup cannot be read"); return { steps, files: [], ok: false }; }
  add("name", FILE_NAME.test(path.basename(file)), FILE_NAME.test(path.basename(file)) ? path.basename(file) : "the name is not the one a backup of this server has (the content is still checked)");
  if (passphrase.length === 0) { add("passphrase", false, "no passphrase was given"); return { steps, files: [], ok: false }; }
  try {
    const files = await openWithKey(raw, keyFromPassphrase(raw, passphrase));
    add("signature", true, "the authentication tag of the file is valid: it is a backup under this passphrase and nobody changed it");
    add("hashes", true, `${files.length} file(s), the SHA-256 of each one matches its manifest`);
    return { steps, files, ok: steps.every(step => step.ok || step.name === "name") };
  } catch (error) {
    add("signature", false, error instanceof BackupError ? error.message : "the backup cannot be opened");
    return { steps, files: [], ok: false };
  }
}

/** What is in the target folder now: whether it exists and whether it holds anything. */
export function targetState(target: string): { exists: boolean; empty: boolean } {
  try {
    const entries = fs.readdirSync(target);
    return { exists: true, empty: entries.length === 0 };
  } catch { return { exists: false, empty: true }; }
}

/** Writes the files under `target`. What is there is copied to a sibling folder first (`<target>.before-restore-<time>`); a path that leaves the target, or goes through a link, is refused. */
export function restoreInto(files: Array<{ path: string; data: Buffer }>, target: string, now: Date = new Date()): { copiedTo?: string; written: number } {
  const root = path.resolve(target);
  const state = targetState(root);
  let copiedTo: string | undefined;
  if (state.exists && !state.empty) {
    copiedTo = `${root}.before-restore-${stampOf(now)}`;
    if (fs.existsSync(copiedTo)) throw new BackupError("copy_exists", "the folder for the copy of what is there already exists", 409);
    fs.cpSync(root, copiedTo, { recursive: true, errorOnExist: true, preserveTimestamps: true });
  }
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const file of files) {
    const destination = path.resolve(root, ...file.path.split("/"));
    const relative = path.relative(root, destination);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new BackupError("corrupt", `${file.path} leaves the folder`, 422);
    let walk = root;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      walk = path.join(walk, part);
      try { if (fs.lstatSync(walk).isSymbolicLink()) throw new BackupError("corrupt", `${file.path} goes through a link`, 422); } catch (error) { if (error instanceof BackupError) throw error; }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { if (fs.lstatSync(destination).isSymbolicLink()) throw new BackupError("corrupt", `${file.path} is a link`, 422); } catch (error) { if (error instanceof BackupError) throw error; }
    const temporary = `${destination}.restore.tmp`;
    fs.writeFileSync(temporary, file.data, { mode: 0o600 });
    fs.renameSync(temporary, destination);
    written++;
  }
  return { copiedTo, written };
}

/** `passphrase` is what the tool read from the environment (tools/armorbk_restore.ts); a file given with --passphrase-file replaces it. */
export type CliIo = { out: (line: string) => void; err: (line: string) => void; passphrase?: string };

const USAGE = "usage: armorbk_restore <backup.armorbk> --to <folder> [--passphrase-file <file>] [--apply]\n  the passphrase is read from ARMOR_BACKUP_PASSPHRASE or from the file, never from the command line\n  without --apply nothing is written: the backup is proved and the checklist is shown";

/** The command: returns the exit code (0 proved or restored, 1 the backup or the target is not fit, 2 wrong use). */
export async function main(argv: string[], io: CliIo, now: Date = new Date()): Promise<number> {
  let file = "", to = "", passphraseFile = "", apply = false;
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!;
    if (item === "--to" || item === "--a") to = argv[++index] ?? "";
    else if (item === "--passphrase-file") passphraseFile = argv[++index] ?? "";
    else if (item === "--apply") apply = true;
    else if (item === "--help" || item === "-h") { io.out(USAGE); return 0; }
    else if (item.startsWith("-") || file !== "") { io.err(USAGE); return 2; }
    else file = item;
  }
  if (file === "" || to === "") { io.err(USAGE); return 2; }
  let passphrase = io.passphrase ?? "";
  if (passphraseFile !== "") { try { passphrase = fs.readFileSync(passphraseFile, "utf8").replace(/\r?\n$/, ""); } catch { io.err("the passphrase file cannot be read"); return 2; } }
  const checked = await checkBackup(file, passphrase);
  for (const step of checked.steps) io.out(`[${step.ok ? "OK" : "FAIL"}] ${step.name}: ${step.detail}`);
  const state = targetState(path.resolve(to));
  io.out(`[${state.exists && !state.empty ? "WARN" : "OK"}] target: ${state.exists ? (state.empty ? "exists and is empty" : "has files: they are copied aside before anything is written") : "does not exist yet: it is created"}`);
  io.out("[TODO] stop the ARMOR server (and anything that writes to the target) before --apply, and start it again after the restore");
  io.out("[TODO] check the restored files and keep the folder with the copy until the installation is seen to work");
  if (!checked.ok) { io.err("the backup is not fit to restore: nothing was written"); return 1; }
  if (!apply) { io.out("RESTORE=PROVED (nothing was written: add --apply to restore)"); return 0; }
  try {
    const result = restoreInto(checked.files, to, now);
    if (result.copiedTo) io.out(`[OK] copy: what was in the target is kept in ${result.copiedTo}`);
    io.out(`RESTORE=DONE files=${result.written}`);
    return 0;
  } catch (error) {
    io.err(error instanceof BackupError ? error.message : "the restore failed");
    return 1;
  }
}
