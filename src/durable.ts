/**
 * Writing a file so that a power cut cannot leave it empty: the data are forced to the disk before the new file takes the old one's name, and the folder is forced after, so that
 * the rename itself survives. (A plain write-then-rename is atomic for a program that is killed, but a power cut on ext4 can still leave the new name on an empty file.)
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

function sync(target: string, flags: string): void {
  let fd: number | undefined;
  try { fd = fs.openSync(target, flags); fs.fsyncSync(fd); } catch { /* a system that cannot sync a folder (Windows) simply does not */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing to do */ } }
}

/** Renames `temporary` over `target` after forcing its content to the disk, then forces the folder. */
export function durableRename(temporary: string, target: string): void {
  sync(temporary, "r+");
  fs.renameSync(temporary, target);
  sync(path.dirname(target), "r");
}

/** Keeps the file that is about to be replaced as `<file>.bak`, when it is there: the last good copy for a file that turns out damaged. */
export function keepBackup(target: string): void {
  try { fs.copyFileSync(target, `${target}.bak`); } catch { /* there was none */ }
}
