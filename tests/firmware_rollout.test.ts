import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { FirmwareService, type FirmwareJob } from "../src/firmware.js";
import { DEFAULT_ROLLOUT, RolloutInvalid, RolloutStore, type RolloutSettings, parseRolloutSettings, rolloutRank, splitWave, waveSize } from "../src/firmware_rollout.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const image = (fill: number, size = 120 * 1024) => { const bytes = Buffer.alloc(size, fill); bytes[0] = 0xe9; return bytes; };
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const LOGIN = { user: "admin", password: "node-pass" };

test("the staged rollout is off by default and turning it on never counts as a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["admin.firmware_rollout"], false);
  assert.equal(lowers("admin.firmware_rollout", false, true), false);
  assert.equal(lowers("admin.firmware_rollout", true, false), false);
});

test("the settings are checked: the channel, the percent, the two switches, and nothing else", () => {
  assert.deepEqual(parseRolloutSettings({}), DEFAULT_ROLLOUT);
  assert.deepEqual(parseRolloutSettings({ channel: "beta", percent: 25, rollback: false, halt_on_failure: false }), { channel: "beta", percent: 25, rollback: false, halt_on_failure: false });
  assert.deepEqual(parseRolloutSettings({ percent: 40 }, { ...DEFAULT_ROLLOUT, channel: "beta" }), { channel: "beta", percent: 40, rollback: true, halt_on_failure: true });
  for (const bad of [{ channel: "nightly" }, { percent: 0 }, { percent: 101 }, { percent: 12.5 }, { percent: "50" }, { rollback: "yes" }, { halt_on_failure: 1 }, { speed: 3 }]) {
    assert.throws(() => parseRolloutSettings(bad), RolloutInvalid, JSON.stringify(bad));
  }
  assert.throws(() => parseRolloutSettings(null), RolloutInvalid);
  assert.throws(() => parseRolloutSettings([]), RolloutInvalid);
});

test("a wave takes the share rounded up, at least one node, and never more than there are", () => {
  assert.deepEqual([0, 1, 3, 10].map(count => waveSize(count, 100)), [0, 1, 3, 10]);
  assert.deepEqual([1, 3, 10, 20].map(count => waveSize(count, 1)), [1, 1, 1, 1]);
  assert.deepEqual([3, 10, 7].map(count => waveSize(count, 34)), [2, 4, 3]);
  assert.equal(waveSize(10, 50), 5);
});

test("the order of the nodes is fixed for a version and a larger percent only adds nodes", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `radar-${index + 1}`);
  const small = splitWave(ids, id => id, "0.9.0", 25), large = splitWave(ids, id => id, "0.9.0", 60);
  assert.equal(small.now.length, 3);
  assert.equal(small.now.length + small.deferred.length, ids.length);
  assert.deepEqual(large.now.slice(0, small.now.length), small.now, "the first nodes stay the first");
  assert.deepEqual(splitWave(ids, id => id, "0.9.0", 25), small, "the same input gives the same split");
  assert.deepEqual([...small.now, ...small.deferred].sort(), [...ids].sort());
  assert.notDeepEqual(splitWave(ids, id => id, "0.9.1", 25).now, small.now, "another version may start with other nodes");
  assert.equal(rolloutRank("radar-1", "0.9.0"), rolloutRank("radar-1", "0.9.0"));
  assert.deepEqual(splitWave<string>([], id => id, "1", 50), { now: [], deferred: [] });
});

test("the settings are kept in a file and read again; a file that cannot be read gives the defaults and a warning", () => {
  const dir = tempDir();
  const file = path.join(dir, "firmware-rollout.json");
  const warnings: string[] = [];
  const first = new RolloutStore(file, message => warnings.push(message));
  assert.deepEqual(first.get(), DEFAULT_ROLLOUT);
  assert.equal(warnings.length, 0);
  first.set({ channel: "beta", percent: 20 });
  assert.throws(() => first.set({ percent: 500 }), RolloutInvalid);
  assert.deepEqual(first.get(), { channel: "beta", percent: 20, rollback: true, halt_on_failure: true }, "a refused value changes nothing");
  assert.deepEqual(new RolloutStore(file).get(), first.get());
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).percent, 20);
  fs.writeFileSync(file, "not json");
  assert.deepEqual(new RolloutStore(file, message => warnings.push(message)).get(), DEFAULT_ROLLOUT);
  assert.equal(warnings.length, 1);
});

/**
 * A stand-in for the panel of a node. Every job target points at it (the address is the same, the node ids differ), so after a node has come back with the new version it goes back
 * to the old one a moment later, as if the next node of the fleet had answered. A node of the `stuck` kind takes the image and keeps answering with the old version, as a node whose new
 * image was refused by the bootloader would; `switched` counts the orders to start from the previous slot.
 */
async function fakeFleet(script: Array<"ok" | "stuck">, options: { switchWorks?: boolean } = {}) {
  const state = { version: "0.5.0", rebootUntil: 0, uploads: 0, switched: 0, updated: 0, resetAfterComeback: false };
  const queue = [...script];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { ...json, ...headers }); response.end(JSON.stringify(payload)); };
      const url = `${request.method} ${request.url}`;
      if (url === "GET /api/v1/session") {
        if (Date.now() < state.rebootUntil) { response.destroy(); return; }
        const shown = state.version;
        if (state.resetAfterComeback && state.version === "0.6.0") { state.resetAfterComeback = false; setTimeout(() => { state.version = "0.5.0"; }, 1); }
        return send(200, { node_id: "radar", kind: "radar", version: shown, board: "s3-eth" });
      }
      if (url === "POST /api/v1/login") return send(200, { ok: true }, { "Set-Cookie": "armor_session=abc123; Path=/; HttpOnly" });
      if (url === "POST /api/v1/ota") {
        const raw = Buffer.concat(chunks);
        state.uploads += 1;
        const outcome = queue.shift() ?? "ok";
        state.rebootUntil = Date.now() + 60;
        if (outcome === "ok") { state.version = "0.6.0"; state.updated += 1; state.resetAfterComeback = true; }
        return send(200, { ok: true, restart_required: true, version: "0.6.0", bytes: raw.length, sha256: sha(raw) });
      }
      if (url === "POST /api/v1/ota/switch") {
        state.switched += 1;
        if (options.switchWorks === false) return send(409, { error: "slot_empty" });
        state.rebootUntil = Date.now() + 40;
        return send(200, { ok: true, restart_required: true, slot: "ota_0", version: "0.5.0" });
      }
      return send(404, { error: "not_found" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, state, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** A stand-in for the API of GitHub: the latest release, and the list of releases with a draft and a pre-release in front. */
async function fakeGithub(bytes: Buffer) {
  const requested: string[] = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: `v${tag}`, ...extra, assets: [{ name: "armor_radar.bin", browser_download_url: `${base}/dl/${tag}/armor_radar.bin` }, { name: "armor_radar.bin.sha256", browser_download_url: `${base}/dl/${tag}/armor_radar.bin.sha256` }] });
    requested.push(url);
    if (/\/releases\/latest$/.test(url)) { response.writeHead(200, json); response.end(JSON.stringify(release("0.6.0"))); return; }
    if (/\/releases\?per_page=10$/.test(url)) { response.writeHead(200, json); response.end(JSON.stringify([release("0.8.0", { draft: true }), release("0.7.0-beta.1", { prerelease: true }), release("0.6.0")])); return; }
    if (/\/dl\/[^/]+\/armor_radar\.bin$/.test(url)) { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(bytes); return; }
    if (/\/dl\/[^/]+\/armor_radar\.bin\.sha256$/.test(url)) { response.writeHead(200); response.end(`${sha(bytes)}  armor_radar.bin\n`); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requested, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const service = (node: { port: number }, github: { api: string }, rollout: () => RolloutSettings | null) =>
  new FirmwareService({ nodePort: () => node.port, releaseApi: () => github.api, requireSignature: false, settleMs: 20, pollMs: 20, restartWaitMs: 600, betweenMs: 10, retryMs: 10, rollout });

async function runJob(firmware: FirmwareService, ids: string[]): Promise<FirmwareJob> {
  const started = firmware.start({ kind: "radar", source: "github", targets: ids.map(id => ({ address: "127.0.0.1", node_id: id })), login: LOGIN });
  for (let i = 0; i < 400; i += 1) {
    const job = firmware.job(started.id) as FirmwareJob;
    if (job.state === "done" || job.state === "failed") return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("the job did not finish");
}

test("with the rollout off a job updates every node with the latest release and says nothing of a rollout", async () => {
  const fleet = await fakeFleet(["ok", "ok", "ok"]), github = await fakeGithub(image(3));
  try {
    const job = await runJob(service(fleet, github, () => null), ["a", "b", "c"]);
    assert.equal(job.state, "done");
    assert.equal(job.targets.length, 3);
    assert.equal(job.rollout, undefined);
    assert.equal(fleet.state.uploads, 3);
    assert.ok(github.requested.every(url => !url.includes("per_page")), "the latest release, not the list");
  } finally { await fleet.close(); await github.close(); }
});

test("a wave sends the version to a share of the nodes and lists the others as deferred; a later, larger wave leaves the first nodes alone", async () => {
  const ids = ["n1", "n2", "n3", "n4"];
  const fleet = await fakeFleet(["ok", "ok", "ok", "ok"]), github = await fakeGithub(image(4));
  try {
    let settings = { ...DEFAULT_ROLLOUT, percent: 50 };
    const firmware = service(fleet, github, () => settings);
    const first = await runJob(firmware, ids);
    const expected = splitWave(ids, id => id, "0.6.0", 50);
    assert.equal(first.state, "done");
    assert.equal(first.targets.length, expected.now.length);
    assert.deepEqual(first.rollout, { channel: "stable", percent: 50, deferred: expected.deferred.map(id => ({ address: "127.0.0.1", node_id: id })), halted: false });
    assert.equal(fleet.state.uploads, 2, "only the nodes of the wave were touched");

    settings = { ...DEFAULT_ROLLOUT, percent: 100 };
    const second = await runJob(firmware, ids);
    assert.equal(second.targets.length, ids.length);
    assert.equal(second.rollout?.deferred.length, 0);
  } finally { await fleet.close(); await github.close(); }
});

test("a node that already has the version is left as it is when the rollout is on", async () => {
  const fleet = await fakeFleet([]), github = await fakeGithub(image(5));
  try {
    fleet.state.version = "0.6.0";
    const job = await runJob(service(fleet, github, () => ({ ...DEFAULT_ROLLOUT, percent: 100 })), ["only"]);
    assert.equal(job.state, "done");
    assert.deepEqual([job.targets[0].skipped, fleet.state.uploads], [true, 0]);
  } finally { await fleet.close(); await github.close(); }
});

test("the beta channel takes the newest release that is not a draft, the stable channel the latest one", async () => {
  const fleet = await fakeFleet(["ok"]), github = await fakeGithub(image(6));
  try {
    const stable = service(fleet, github, () => ({ ...DEFAULT_ROLLOUT, channel: "stable" }));
    assert.equal((await stable.releaseInfo("radar")).version, "0.6.0");
    const beta = service(fleet, github, () => ({ ...DEFAULT_ROLLOUT, channel: "beta" }));
    assert.equal((await beta.releaseInfo("radar")).version, "0.7.0-beta.1", "the draft 0.8.0 is skipped, the pre-release is taken");
    assert.ok(github.requested.some(url => url.endsWith("/releases?per_page=10")));
    assert.equal((await service(fleet, github, () => null).releaseInfo("radar")).version, "0.6.0", "the option off means stable");
  } finally { await fleet.close(); await github.close(); }
});

test("a node that took the image and did not come back is asked to start from its previous slot, and the nodes still to come are left alone", async () => {
  const ids = ["n1", "n2", "n3"];
  const fleet = await fakeFleet(["stuck", "ok", "ok"]), github = await fakeGithub(image(7));
  try {
    const job = await runJob(service(fleet, github, () => ({ ...DEFAULT_ROLLOUT })), ids);
    const order = splitWave(ids, id => id, "0.6.0", 100).now;
    assert.equal(job.state, "failed");
    assert.equal(job.targets.length, 1, "the nodes after the failed one are not in the job");
    assert.deepEqual([job.targets[0].error, job.targets[0].rolled_back, job.targets[0].rollback_error], ["did_not_come_back", true, undefined]);
    assert.deepEqual(job.rollout?.deferred.map(item => item.node_id), order.slice(1));
    assert.equal(job.rollout?.halted, true);
    assert.deepEqual([fleet.state.uploads, fleet.state.switched], [1, 1]);
  } finally { await fleet.close(); await github.close(); }
});

test("with the way back and the halt switched off a failure is only reported and the next node is tried", async () => {
  const ids = ["n1", "n2"];
  const fleet = await fakeFleet(["stuck", "ok"]), github = await fakeGithub(image(8));
  try {
    const job = await runJob(service(fleet, github, () => ({ ...DEFAULT_ROLLOUT, rollback: false, halt_on_failure: false })), ids);
    assert.equal(job.state, "failed");
    assert.equal(job.targets.length, 2);
    assert.deepEqual(job.targets.map(target => target.state), ["failed", "done"]);
    assert.deepEqual([job.targets[0].rolled_back, fleet.state.switched, job.rollout?.halted, job.rollout?.deferred.length], [undefined, 0, false, 0]);
  } finally { await fleet.close(); await github.close(); }
});

test("a node that refuses the way back is reported with the reason and the job still stops", async () => {
  const fleet = await fakeFleet(["stuck", "ok"], { switchWorks: false }), github = await fakeGithub(image(9));
  try {
    const job = await runJob(service(fleet, github, () => ({ ...DEFAULT_ROLLOUT })), ["n1", "n2"]);
    assert.equal(job.state, "failed");
    assert.deepEqual([job.targets[0].rolled_back, job.targets[0].rollback_error, job.rollout?.halted], [undefined, "rollback_refused", true]);
  } finally { await fleet.close(); await github.close(); }
});

test("an uploaded image is not part of the staged rollout: it goes to every node it was given", async () => {
  const fleet = await fakeFleet(["ok", "ok"]), github = await fakeGithub(image(1));
  try {
    const firmware = service(fleet, github, () => ({ ...DEFAULT_ROLLOUT, percent: 1 }));
    const upload = firmware.addUpload(image(2), "armor_radar.bin");
    const started = firmware.start({ kind: "radar", source: "upload", uploadId: upload.id, targets: [{ address: "127.0.0.1", node_id: "u1" }, { address: "127.0.0.1", node_id: "u2" }], login: LOGIN });
    for (let i = 0; i < 400; i += 1) { const job = firmware.job(started.id) as FirmwareJob; if (job.state !== "running" && job.state !== "preparing") break; await new Promise(resolve => setTimeout(resolve, 25)); }
    const job = firmware.job(started.id) as FirmwareJob;
    assert.equal(job.targets.length, 2);
    assert.equal(job.rollout, undefined);
  } finally { await fleet.close(); await github.close(); }
});

test("the routes: the settings are read and saved while the option is off, a wrong value is refused, and the option is told", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const headers = { "content-type": "application/json", cookie: admin };
    const url = `${running.base}/api/v1/admin/firmware/rollout`;
    assert.equal((await fetch(url)).status, 401);
    const first = await (await fetch(url, { headers })).json() as { enabled: boolean; settings: unknown };
    assert.deepEqual(first, { enabled: false, settings: DEFAULT_ROLLOUT });
    const saved = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ channel: "beta", percent: 30 }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { enabled: false, settings: { channel: "beta", percent: 30, rollback: true, halt_on_failure: true } });
    const bad = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ percent: 0 }) });
    assert.equal(bad.status, 422);
    assert.equal(((await bad.json()) as { code: string }).code, "invalid_settings");
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "admin.firmware_rollout": true }) })).status, 200);
    const on = await (await fetch(url, { headers })).json() as { enabled: boolean; settings: { percent: number } };
    assert.deepEqual([on.enabled, on.settings.percent], [true, 30], "the saved settings are kept");
    assert.ok(fs.existsSync(path.join(running.config.dataDir, "firmware-rollout.json")));
  } finally { await running.stop(); }
});
