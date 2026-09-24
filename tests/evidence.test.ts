import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAuditLog, scrub } from "../src/audit.js";
import { EvidenceLibrary, mediaKindFrom } from "../src/media/evidence.js";
import { StreamTickets } from "../src/media/relay.js";
import { tempDir } from "./helpers.js";

const library = (extra: Partial<ConstructorParameters<typeof EvidenceLibrary>[0]> = {}) =>
  new EvidenceLibrary({ root: path.join(tempDir(), "media"), ffmpegPath: "", maxBytes: 1024 ** 3, retentionMs: 0, ...extra });

function put(lib: EvidenceLibrary, camera: string, kind: "snapshots" | "recordings", file: string, size = 100, ageMs = 0): string {
  const folder = lib.directory(camera, kind);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, file);
  fs.writeFileSync(target, Buffer.alloc(size, 1));
  if (ageMs) { const when = new Date(Date.now() - ageMs); fs.utimesSync(target, when, when); }
  return target;
}

test("only well-formed file names inside the camera folder are addressable", () => {
  const lib = library();
  assert.ok(lib.file("cam-1", "snapshots", "snapshot-1.jpg"));
  for (const bad of ["../x.jpg", "a/b.jpg", "x.txt", ".hidden.jpg", "x.part.mp4", "", "x.jpg.protected", "..%2Fx.jpg"]) assert.equal(lib.file("cam-1", "snapshots", bad), null, bad);
  assert.equal(lib.file("a", "snapshots", "x.jpg"), null);
  assert.equal(lib.file("../evil", "snapshots", "x.jpg"), null);
  assert.throws(() => lib.directory("../evil", "snapshots"));
  assert.equal(mediaKindFrom("snapshots"), "snapshots");
  assert.equal(mediaKindFrom("other"), null);
});

test("the catalogue lists real files newest first and ignores empty ones", async () => {
  const lib = library();
  put(lib, "cam-1", "snapshots", "old.jpg", 100, 60_000);
  put(lib, "cam-1", "recordings", "clip.mp4", 500);
  put(lib, "cam-1", "snapshots", "empty.jpg", 0);
  const items = await lib.list();
  assert.deepEqual(items.map(item => item.file), ["clip.mp4", "old.jpg"]);
  assert.equal(items[0].kind, "recording");
  assert.equal(items[0].protected, false);
});

test("retention removes the oldest evidence first and never protected evidence", async () => {
  const lib = library({ maxBytes: 64 * 1024 * 1024 });
  const big = 40 * 1024 * 1024;
  put(lib, "cam-1", "recordings", "a.mp4", big, 3 * 60_000);
  put(lib, "cam-1", "recordings", "b.mp4", big, 2 * 60_000);
  put(lib, "cam-1", "recordings", "c.mp4", big, 1 * 60_000);
  assert.equal(lib.setProtected("cam-1", "recordings", "a.mp4", true), true);
  assert.equal(await lib.prune(), 2);
  assert.deepEqual((await lib.list()).map(item => item.file), ["a.mp4"]);
});

test("age-based retention deletes only expired unprotected files", async () => {
  const lib = library({ retentionMs: 60 * 60_000 });
  put(lib, "cam-1", "snapshots", "expired.jpg", 10, 2 * 60 * 60_000);
  put(lib, "cam-1", "snapshots", "kept.jpg", 10, 60_000);
  put(lib, "cam-1", "snapshots", "held.jpg", 10, 3 * 60 * 60_000);
  lib.setProtected("cam-1", "snapshots", "held.jpg", true);
  assert.equal(await lib.prune(), 1);
  assert.deepEqual((await lib.list()).map(item => item.file).sort(), ["held.jpg", "kept.jpg"]);
});

test("protection can be removed, and a protected file survives bulk deletion", async () => {
  const lib = library();
  put(lib, "cam-1", "snapshots", "a.jpg");
  put(lib, "cam-1", "snapshots", "b.jpg");
  lib.setProtected("cam-1", "snapshots", "a.jpg", true);
  assert.equal(await lib.removeAll(["snapshots"]), 1);
  assert.deepEqual((await lib.list()).map(item => item.file), ["a.jpg"]);
  lib.setProtected("cam-1", "snapshots", "a.jpg", false);
  assert.equal(await lib.removeAll(["snapshots"]), 1);
  assert.equal(lib.setProtected("cam-1", "snapshots", "missing.jpg", true), false);
});

test("the SHA-256 matches the file and a missing file has none", async () => {
  const lib = library();
  const target = put(lib, "cam-1", "snapshots", "a.jpg", 2048);
  assert.equal(await lib.sha256("cam-1", "snapshots", "a.jpg"), createHash("sha256").update(fs.readFileSync(target)).digest("hex"));
  assert.equal(await lib.sha256("cam-1", "snapshots", "nope.jpg"), null);
  assert.equal(await lib.sha256("cam-1", "snapshots", "../a.jpg"), null);
});

test("removing evidence also removes its protection marker", () => {
  const lib = library();
  const target = put(lib, "cam-1", "snapshots", "a.jpg");
  lib.setProtected("cam-1", "snapshots", "a.jpg", true);
  assert.equal(lib.remove("cam-1", "snapshots", "a.jpg"), true);
  assert.equal(fs.existsSync(`${target}.protected`), false);
  assert.equal(lib.remove("cam-1", "snapshots", "a.jpg"), false);
});

test("capture without FFmpeg or credentials fails with a clear, safe message", async () => {
  const lib = library();
  const camera = { id: "cam-1", name: "x", host: "h", snapshotUrl: "", rtspPath: "live", onvifPort: 80, rtspPort: 554, secrets: { username: "u", password: "p" } };
  await assert.rejects(lib.snapshot(camera), /FFmpeg is not configured/);
  await assert.rejects(lib.startRecording(camera), /FFmpeg is not configured/);
  await assert.rejects(lib.startRecording({ ...camera, secrets: undefined }), /credentials are required/);
  await assert.rejects(lib.stopRecording("cam-1"), /not recording/);
});

test("stream tickets are camera-bound, expire and are capped", () => {
  let now = 1_000;
  const tickets = new StreamTickets(60_000, 3, () => now);
  const grant = tickets.issue("cam-1");
  assert.equal(tickets.valid(grant.ticket, "cam-1"), true);
  assert.equal(tickets.valid(grant.ticket, "cam-2"), false);
  assert.equal(tickets.valid(undefined, "cam-1"), false);
  assert.equal(tickets.valid(["x"], "cam-1"), false);
  now += 60_001;
  assert.equal(tickets.valid(grant.ticket, "cam-1"), false);
  const first = tickets.issue("cam-1").ticket;
  for (let index = 0; index < 5; index += 1) tickets.issue("cam-1");
  assert.equal(tickets.valid(first, "cam-1"), false);
});

test("audit lines never carry credentials", () => {
  assert.equal(scrub("rtsp://admin:pw@10.0.0.1/live"), "rtsp://***@10.0.0.1/live");
  assert.doesNotMatch(scrub('password=hunter2 token: abc123 Authorization "Bearer x"'), /hunter2|abc123/);
  const lines: string[] = [];
  const log = createAuditLog(tempDir(), line => lines.push(line), () => new Date("2026-01-01T00:00:00Z"));
  log.record({ action: "camera.configure", outcome: "allowed", actor: "admin", detail: "password=secret" });
  assert.match(lines[0], /^ARMOR_AUDIT \{"at":"2026-01-01T00:00:00.000Z","action":"camera.configure"/);
  assert.doesNotMatch(lines[0], /secret/);
});
