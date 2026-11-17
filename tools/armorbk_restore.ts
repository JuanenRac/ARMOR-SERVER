/**
 * Restores an encrypted `.armorbk` backup without the server running: `npx tsx tools/armorbk_restore.ts <backup> --to <folder> [--passphrase-file <file>] [--apply]`.
 * Without --apply it only proves the backup and shows the checklist. See src/backup_restore.ts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { main } from "../src/backup_restore.js";

process.exitCode = await main(process.argv.slice(2), { out: line => console.log(line), err: line => console.error(line), env: process.env });
