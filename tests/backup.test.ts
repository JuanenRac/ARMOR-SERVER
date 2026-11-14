import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackupError, BackupService, DEFAULT_SETTINGS, MAGIC, parseBackupSettings } from "../src/backup.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const PASSPHRASE = "correct horse battery";   // a made-up value for the tests
function bench(settings: Record<string, unknown> = {}) {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "alarms.json"), "{\"alarms\":[1,2,3]}");
  fs.mkdirSync(path.join(dataDir, "sub"));
  fs.writeFileSync(path.join(dataDir, "sub", "known-nodes.json"), "nodes");
  fs.mkdirSync(path.join(dataDir, "evidence"));
  fs.writeFileSync(path.join(dataDir, "evidence", "clip.mp4"), "video bytes");
  fs.writeFileSync(path.join(dataDir, "half.tmp"), "temporary");
  const events: string[] = [];
  let clock = Date.UTC(2026, 0, 1, 10, 0, 0);
  const service = new BackupService({ dataDir, stateDir: dataDir, now: () => new Date(clock), onEvent: (action, outcome, detail) => { events.push(`${action}:${outcome}:${detail}`); } });
  service.configure({ passphrase: PASSPHRASE, ...settings });
  return { service, dataDir, events, advance: (ms: number) => { clock += ms; } };
}

test("the option is off by default and turning it on counts as a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["admin.backup"], false);
  assert.equal(lowers("admin.backup", false, true), true);
  assert.equal(lowers("admin.backup", true, false), false);
});

test("the settings are checked: types, ranges, unknown keys, and a destination that is a plain absolute path", () => {
  assert.deepEqual(parseBackupSettings({}), DEFAULT_SETTINGS);
  for (const bad of [{ every_h: 0 }, { every_h: 721 }, { keep: 0 }, { keep: 61 }, { max_mb: 0.5 }, { schedule: "yes" }, { surprise: 1 }, { destination: "relative/path" }, { destination: "/media/../etc" },
    { destination: "/media/x\0y" }, { destination: 5 }, [], null, "text"]) assert.throws(() => parseBackupSettings(bad), BackupError, JSON.stringify(bad));
  assert.equal(parseBackupSettings({ destination: "/media/usb", keep: 3 }).keep, 3);
});

test("a backup holds the data, leaves out the media, the temporary files and the backups, and is encrypted", async () => {
  const { service, dataDir, events } = bench();
  const result = await service.run("admin");
  assert.equal(result.ok, true);
  assert.equal(result.files, 3, "alarms.json, sub/known-nodes.json and the settings of the backup itself, not the key");
  const raw = fs.readFileSync(path.join(dataDir, "backups", result.file!));
  assert.deepEqual(raw.subarray(0, 8), MAGIC);
  assert.equal(raw.includes(Buffer.from("alarms")), false, "nothing readable is in the file");
  const files = await service.open(raw);
  assert.deepEqual(files.map(file => file.path), ["alarms.json", "backup.json", "sub/known-nodes.json"]);
  assert.equal(files.find(file => file.path === "alarms.json")?.data.toString(), "{\"alarms\":[1,2,3]}");
  assert.ok(events.some(item => item.startsWith("backup_made:allowed:armor-backup-")));
});

test("with the media on they are included, and a backup over the size limit is refused", async () => {
  const withMedia = bench({ include_media: true });
  assert.ok((await withMedia.service.run()).files! >= 4);
  const small = bench({ max_mb: 1 });
  fs.writeFileSync(path.join(small.dataDir, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
  await assert.rejects(small.service.run(), { code: "too_large" });
  assert.equal(small.service.status().last?.ok, false);
});

test("a backup is proved: it opens with the key or the passphrase, and a changed byte or a wrong passphrase does not", async () => {
  const { service, dataDir, events } = bench();
  const made = await service.run();
  const proof = await service.verify();
  assert.deepEqual({ ok: proof.ok, file: proof.file, files: proof.files }, { ok: true, file: made.file, files: 3 });
  assert.ok(events.some(item => item.startsWith("backup_restored:allowed")));
  assert.equal((await service.verify(made.file, PASSPHRASE)).ok, true, "with the passphrase alone, as another machine would");
  await assert.rejects(service.verify(made.file, "not the passphrase at all"), { code: "wrong_key" });
  const file = path.join(dataDir, "backups", made.file!);
  const raw = fs.readFileSync(file);
  raw[raw.length - 5] ^= 0xff;
  fs.writeFileSync(file, raw);
  await assert.rejects(service.verify(made.file), { code: "wrong_key" }, "the tag catches a changed byte");
  assert.equal(service.status().last_verify?.ok, false);
  await assert.rejects(service.verify("../../etc/passwd"), { code: "invalid_name" });
  await assert.rejects(service.verify("armor-backup-20200101T000000Z.armorbk"), { code: "no_backup" });
  await assert.rejects(service.open(Buffer.from("not a backup at all, only some bytes of text")), { code: "corrupt" });
});

test("the proof leaves nothing behind in the temporary folder", async () => {
  const { service } = bench();
  await service.run();
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("armor-restore-")).length;
  await service.verify();
  assert.equal(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("armor-restore-")).length, before);
});

test("the oldest backups are removed beyond the number to keep, and the schedule makes one when it is due", async () => {
  const { service, advance, dataDir } = bench({ keep: 2, schedule: true, every_h: 2 });
  assert.equal(await service.tick(true), true, "none yet: due at once");
  assert.equal(await service.tick(true), false, "not due again yet");
  assert.equal(await service.tick(false), false, "the option is off");
  advance(3 * 3_600_000);
  assert.equal(await service.tick(true), true);
  advance(3 * 3_600_000);
  assert.equal(await service.tick(true), true);
  const names = fs.readdirSync(path.join(dataDir, "backups")).filter(name => name.endsWith(".armorbk"));
  assert.equal(names.length, 2, "only the two newest are left");
  assert.equal(service.list()[0].name, names.sort().reverse()[0]);
});

test("a backup needs a passphrase, a strong enough one, and a destination under an allowed place", async () => {
  const dataDir = tempDir();
  const service = new BackupService({ dataDir, stateDir: dataDir });
  await assert.rejects(service.run(), { code: "passphrase_needed" });
  assert.throws(() => service.configure({ schedule: true }), { code: "passphrase_needed" });
  assert.throws(() => service.configure({ passphrase: "short" }), { code: "weak_passphrase" });
  assert.throws(() => service.configure({ passphrase: 12345678901234 }), { code: "weak_passphrase" });
  assert.throws(() => service.configure({ passphrase: PASSPHRASE, destination: "/etc" }), { code: "destination_not_allowed" });
  assert.throws(() => service.configure({ passphrase: PASSPHRASE, destination: "/mediaX/usb" }), { code: "destination_not_allowed" });
  service.configure({ passphrase: PASSPHRASE, destination: "/media/usb-backup" });
  assert.equal(service.settings.destination, "/media/usb-backup");
  assert.equal(JSON.stringify(service.status()).includes(PASSPHRASE), false, "the passphrase is never returned");
  assert.equal(fs.readFileSync(path.join(dataDir, "backup-key.json"), "utf8").includes(PASSPHRASE), false, "and never kept");
});

test("a destination on the same device as the data is refused while it must be a mounted drive; a restart keeps the key and the settings", async () => {
  const dataDir = tempDir();
  const allowed = path.join(dataDir, "mnt");
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(dataDir, "backup.json"), JSON.stringify({ schema: 1, settings: {}, allowed_roots: [allowed] }));
  const service = new BackupService({ dataDir, stateDir: dataDir });
  service.configure({ passphrase: PASSPHRASE, destination: path.join(allowed, "usb"), keep: 5 });
  fs.mkdirSync(path.join(allowed, "usb"));
  await assert.rejects(service.run(), { code: "not_mounted" });
  service.configure({ require_mount: false });
  const made = await service.run();
  assert.ok(fs.existsSync(path.join(allowed, "usb", made.file!)));
  const again = new BackupService({ dataDir, stateDir: dataDir });
  assert.equal(again.keySet, true);
  assert.equal(again.settings.keep, 5);
  assert.equal(again.status().last?.file, made.file);
  assert.equal((await again.verify()).ok, true, "the key made before the restart opens it");
});

test("the routes answer 403 while the option is off, and an administrator sets, makes and proves a backup once it is on", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const json = { "content-type": "application/json", cookie: admin };
    const state = await (await fetch(`${running.base}/api/v1/admin/backup`, { headers: json })).json() as { enabled: boolean };
    assert.equal(state.enabled, false);
    for (const [method, route] of [["PUT", ""], ["POST", "/run"], ["POST", "/verify"]]) {
      const refused = await fetch(`${running.base}/api/v1/admin/backup${route}`, { method, headers: json, body: "{}" });
      assert.equal(refused.status, 403, route);
      assert.equal(((await refused.json()) as { code: string }).code, "backup_disabled");
    }
    assert.equal((await fetch(`${running.base}/api/v1/admin/backup`)).status, 401, "no session, no answer");
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: json, body: JSON.stringify({ "admin.backup": true }) })).status, 200);
    const noKey = await fetch(`${running.base}/api/v1/admin/backup/run`, { method: "POST", headers: json, body: "{}" });
    assert.equal(noKey.status, 422);
    const configured = await fetch(`${running.base}/api/v1/admin/backup`, { method: "PUT", headers: json, body: JSON.stringify({ passphrase: PASSPHRASE, keep: 3 }) });
    assert.equal(configured.status, 200);
    const text = await configured.text();
    assert.equal(text.includes(PASSPHRASE), false);
    assert.equal((JSON.parse(text) as { key_set: boolean }).key_set, true);
    const run = await fetch(`${running.base}/api/v1/admin/backup/run`, { method: "POST", headers: json, body: "{}" });
    assert.equal(run.status, 200);
    const result = await run.json() as { ok: boolean; file: string };
    assert.equal(result.ok, true);
    const verify = await fetch(`${running.base}/api/v1/admin/backup/verify`, { method: "POST", headers: json, body: JSON.stringify({ name: result.file }) });
    assert.equal(verify.status, 200);
    assert.equal(((await verify.json()) as { ok: boolean }).ok, true);
    assert.equal((await fetch(`${running.base}/api/v1/admin/backup/verify`, { method: "POST", headers: json, body: JSON.stringify({ name: 5 }) })).status, 422);
    const listed = await (await fetch(`${running.base}/api/v1/admin/backup`, { headers: json })).json() as { backups: Array<{ name: string }> };
    assert.equal(listed.backups[0].name, result.file);
  } finally { await running.stop(); }
});
