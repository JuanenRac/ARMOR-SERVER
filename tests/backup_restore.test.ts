import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BackupService } from "../src/backup.js";
import { checkBackup, main, restoreInto, targetState } from "../src/backup_restore.js";
import { tempDir } from "./helpers.js";

const PASSPHRASE = "correct horse battery";   // a made-up value for the tests

async function made() {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "alarms.json"), "{\"alarms\":[1,2,3]}");
  fs.mkdirSync(path.join(dataDir, "sub"));
  fs.writeFileSync(path.join(dataDir, "sub", "known-nodes.json"), "nodes");
  const service = new BackupService({ dataDir, stateDir: dataDir, now: () => new Date(Date.UTC(2026, 0, 1, 10, 0, 0)) });
  service.configure({ passphrase: PASSPHRASE });
  const result = await service.run("admin");
  return { dataDir, file: path.join(dataDir, "backups", result.file!) };
}

const quiet = (passphrase?: string) => { const lines: string[] = [], errors: string[] = []; return { lines, errors, io: { out: (line: string) => { lines.push(line); }, err: (line: string) => { errors.push(line); }, passphrase } }; };

test("a backup is proved without the server: the signature and the hash of every file, and a wrong passphrase or a changed file is refused", async () => {
  const { file } = await made();
  const good = await checkBackup(file, PASSPHRASE);
  assert.equal(good.ok, true);
  assert.deepEqual(good.files.map(item => item.path).sort(), ["alarms.json", "backup.json", "sub/known-nodes.json"].sort());
  assert.equal((await checkBackup(file, "another passphrase")).ok, false);
  assert.equal((await checkBackup(file, "")).ok, false);
  const raw = fs.readFileSync(file);
  raw[raw.length - 3] ^= 0xff;
  const changed = path.join(path.dirname(file), "armor-backup-20260101T100001Z.armorbk");
  fs.writeFileSync(changed, raw);
  const refused = await checkBackup(changed, PASSPHRASE);
  assert.equal(refused.ok, false);
  assert.equal(refused.steps.find(step => step.name === "signature")?.ok, false);
  assert.equal((await checkBackup(path.join(path.dirname(file), "missing.armorbk"), PASSPHRASE)).ok, false);
});

test("the restore is a round trip: what was backed up comes back byte for byte, and what was in the target is copied aside first", async () => {
  const { file } = await made();
  const target = path.join(tempDir(), "restored");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "alarms.json"), "newer data that must not be lost");
  const checked = await checkBackup(file, PASSPHRASE);
  const result = restoreInto(checked.files, target, new Date(Date.UTC(2026, 1, 2, 3, 4, 5)));
  assert.equal(result.written, 3);
  assert.equal(fs.readFileSync(path.join(target, "alarms.json"), "utf8"), "{\"alarms\":[1,2,3]}");
  assert.equal(fs.readFileSync(path.join(target, "sub", "known-nodes.json"), "utf8"), "nodes");
  assert.equal(result.copiedTo, `${path.resolve(target)}.before-restore-20260202T030405Z`);
  assert.equal(fs.readFileSync(path.join(result.copiedTo!, "alarms.json"), "utf8"), "newer data that must not be lost");
  assert.throws(() => restoreInto(checked.files, target, new Date(Date.UTC(2026, 1, 2, 3, 4, 5))), /already exists/);
  assert.deepEqual(targetState(path.join(tempDir(), "nowhere")), { exists: false, empty: true });
});

test("a path that leaves the target or goes through a link is refused and nothing is written outside", () => {
  const target = path.join(tempDir(), "t");
  assert.throws(() => restoreInto([{ path: "../escape.txt", data: Buffer.from("x") }], target), /leaves the folder/);
  assert.equal(fs.existsSync(path.join(path.dirname(target), "escape.txt")), false);
  const outside = tempDir();
  fs.mkdirSync(target, { recursive: true });
  try { fs.symlinkSync(outside, path.join(target, "link"), "dir"); } catch { return; }   // a link cannot be made here: nothing more to prove
  assert.throws(() => restoreInto([{ path: "link/file.txt", data: Buffer.from("x") }], target), /link/);
  assert.equal(fs.existsSync(path.join(outside, "file.txt")), false);
});

test("the command proves and shows the checklist without writing, and only writes with --apply; the passphrase never comes from the command line", async () => {
  const { file } = await made();
  const target = path.join(tempDir(), "out");
  const dry = quiet(PASSPHRASE);
  assert.equal(await main([file, "--to", target], dry.io), 0);
  assert.ok(dry.lines.some(line => line.startsWith("RESTORE=PROVED")));
  assert.ok(dry.lines.some(line => line.startsWith("[TODO] stop the ARMOR server")));
  assert.equal(fs.existsSync(target), false, "without --apply nothing is written");
  const wrong = quiet("wrong passphrase");
  assert.equal(await main([file, "--to", target, "--apply"], wrong.io), 1);
  assert.equal(fs.existsSync(target), false, "a backup that is not proved is never restored");
  const apply = quiet(PASSPHRASE);
  assert.equal(await main([file, "--a", target, "--apply"], apply.io), 0);
  assert.ok(apply.lines.some(line => line === "RESTORE=DONE files=3"));
  assert.equal(fs.readFileSync(path.join(target, "alarms.json"), "utf8"), "{\"alarms\":[1,2,3]}");
  const secret = path.join(tempDir(), "pass.txt");
  fs.writeFileSync(secret, `${PASSPHRASE}\n`);
  assert.equal(await main([file, "--to", path.join(tempDir(), "again"), "--passphrase-file", secret], quiet().io), 0);
  const usage = quiet();
  assert.equal(await main(["--passphrase", PASSPHRASE, file], usage.io), 2);
  assert.equal(await main([file], quiet().io), 2);
});
