import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { FirmwareService, parseChecksum } from "../src/firmware.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const image = (fill: number, size = 120 * 1024) => { const bytes = Buffer.alloc(size, fill); bytes[0] = 0xe9; return bytes; };
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

type Seen = { url: string; cookie: string; requestedWith: string; bytes: number; sha256: string };

/** A stand-in for a node's panel: its session, its login and its update route; after an update it comes back with the new version. */
async function fakeNode(options: { password?: string; version?: string; newVersion?: string; lieAboutHash?: boolean } = {}) {
  const state = { version: options.version ?? "0.5.0", reboot: 0 }, seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { ...json, ...headers }); response.end(JSON.stringify(payload)); };
      const url = `${request.method} ${request.url}`;
      if (url === "GET /api/v1/session") {
        if (state.reboot > 0 && Date.now() < state.reboot) { response.destroy(); return; }
        return send(200, { node_id: "nodo-radar-2", version: state.version, board: "s3-eth" });
      }
      if (url === "POST /api/v1/login") {
        const input = JSON.parse(raw.toString("utf8")) as { password?: string };
        return input.password === (options.password ?? "node-pass") ? send(200, { ok: true }, { "Set-Cookie": "armor_session=abc123; Path=/; HttpOnly" }) : send(401, { error: "wrong_credentials" });
      }
      if (url === "POST /api/v1/ota") {
        const cookie = String(request.headers.cookie ?? "");
        if (cookie !== "armor_session=abc123") return send(401, { error: "unauthorized" });
        seen.push({ url, cookie, requestedWith: String(request.headers["x-requested-with"] ?? ""), bytes: raw.length, sha256: sha(raw) });
        state.version = options.newVersion ?? "0.5.4";
        state.reboot = Date.now() + 120;
        return send(200, { ok: true, restart_required: true, version: state.version, bytes: raw.length, sha256: options.lieAboutHash ? "0".repeat(64) : sha(raw) });
      }
      return send(404, { error: "not_found" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, state, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** A stand-in for GitHub's API: the latest release of every repository, with its image, its hash file or neither. */
async function fakeGithub(release: { tag: string; image: Buffer; checksum?: string | null; omitChecksumAsset?: boolean }) {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
      const assets = [{ name: "armor_radar.bin", browser_download_url: `${base}/dl/armor_radar.bin` }, ...(release.omitChecksumAsset ? [] : [{ name: "armor_radar.bin.sha256", browser_download_url: `${base}/dl/armor_radar.bin.sha256` }])];
      response.writeHead(200, json); response.end(JSON.stringify({ tag_name: `v${release.tag}`, assets })); return;
    }
    if (url === "/dl/armor_radar.bin") { response.writeHead(302, { Location: "/storage/armor_radar.bin" }); response.end(); return; }   // GitHub redirects a download
    if (url === "/storage/armor_radar.bin") { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(release.image); return; }
    if (url === "/dl/armor_radar.bin.sha256") { response.writeHead(200); response.end(`${release.checksum ?? sha(release.image)}  armor_radar.bin\n`); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function withServer(node: { port: number }, github: { api: string } | null, run: (running: Running, cookie: string) => Promise<void>): Promise<void> {
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const firmware = new FirmwareService({ nodePort: () => node.port, releaseApi: () => github?.api ?? "http://127.0.0.1:9", settleMs: 20, pollMs: 20, restartWaitMs: 3000 });
  const running = await startServer({}, { firmware });
  try { await run(running, await studioCookie(running.base)); } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); }
}

const call = async (running: Running, cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = json) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...headers, Cookie: cookie }, body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};

const finished = async (running: Running, cookie: string, id: string) => {
  for (let i = 0; i < 200; i++) {
    const job = (await call(running, cookie, "GET", `/api/v1/admin/firmware/jobs/${id}`)).body;
    if (job.state === "done" || job.state === "failed") return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("the job did not finish");
};

test("the hash file of a release is read the way sha256sum writes it", () => {
  const hash = "ab".repeat(32);
  assert.equal(parseChecksum(`${hash}  armor_radar.bin\n`), hash);
  assert.equal(parseChecksum(`${hash.toUpperCase()} *armor_radar.bin`), hash);
  assert.equal(parseChecksum(hash), hash);
  assert.equal(parseChecksum("not a hash"), undefined);
  assert.equal(parseChecksum(`${hash}ff`), undefined, "longer than a SHA-256");
});

test("an uploaded image updates a node: it signs in, sends the image, and waits for the node to come back with the new version", async () => {
  const node = await fakeNode();
  try {
    await withServer(node, null, async (running, cookie) => {
      const bytes = image(7);
      const uploaded = await call(running, cookie, "POST", "/api/v1/admin/firmware/uploads", bytes, { "Content-Type": "application/octet-stream", "X-Firmware-Name": "armor radar 0.5.4.bin" });
      assert.equal(uploaded.status, 201);
      assert.deepEqual([uploaded.body.bytes, uploaded.body.sha256, uploaded.body.name], [bytes.length, sha(bytes), "armor_radar_0.5.4.bin"]);

      const probe = await call(running, cookie, "POST", "/api/v1/admin/firmware/probe", { addresses: ["127.0.0.1"] });
      assert.deepEqual([probe.body.nodes[0].reachable, probe.body.nodes[0].version, probe.body.nodes[0].node_id], [true, "0.5.0", "nodo-radar-2"]);

      const started = await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "radar", source: "upload", upload_id: uploaded.body.id, targets: [{ address: "127.0.0.1", node_id: "nodo-radar-2" }], panel_user: "admin", panel_password: "node-pass" });
      assert.equal(started.status, 202);
      const job = await finished(running, cookie, started.body.id);
      assert.equal(job.state, "done");
      assert.deepEqual([job.targets[0].state, job.targets[0].version_before, job.targets[0].version_after], ["done", "0.5.0", "0.5.4"]);
      assert.deepEqual([job.targets[0].progress, job.targets[0].sent, job.targets[0].total], [100, bytes.length, bytes.length], "the console is told how far the picture got");
      assert.deepEqual(node.seen.map(item => [item.cookie, item.requestedWith, item.bytes, item.sha256]), [["armor_session=abc123", "armor", bytes.length, sha(bytes)]]);

      // the login of the node is not in what the job says about itself, nor in the audit trail
      assert.doesNotMatch(JSON.stringify(job), /node-pass/);
      const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
      assert.match(audit, /admin\.firmware\.node/);
      assert.doesNotMatch(audit, /node-pass/);
    });
  } finally { await node.close(); }
});

test("the newest release of GitHub is downloaded (through its redirect), checked against its hash and sent to the node", async () => {
  const node = await fakeNode(), bytes = image(3), github = await fakeGithub({ tag: "0.5.4", image: bytes });
  try {
    await withServer(node, github, async (running, cookie) => {
      const info = await call(running, cookie, "GET", "/api/v1/admin/firmware/releases/radar");
      assert.deepEqual([info.status, info.body.version, info.body.bytes, info.body.checksum], [200, "0.5.4", bytes.length, true]);
      const started = await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "radar", source: "github", targets: [{ address: "127.0.0.1" }], panel_user: "admin", panel_password: "node-pass" });
      const job = await finished(running, cookie, started.body.id);
      assert.equal(job.state, "done");
      assert.equal(job.version, "0.5.4");
      assert.equal(node.seen[0].sha256, sha(bytes));
    });
  } finally { await node.close(); await github.close(); }
});

test("a release whose image does not match its hash, or that has none, is never sent", async () => {
  for (const [release, expected] of [
    [{ tag: "0.5.4", image: image(3), checksum: "f".repeat(64) }, "checksum_mismatch"],
    [{ tag: "0.5.4", image: image(3), omitChecksumAsset: true }, "no_checksum"],
  ] as const) {
    const node = await fakeNode(), github = await fakeGithub(release);
    try {
      await withServer(node, github, async (running, cookie) => {
        const started = await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "radar", source: "github", targets: [{ address: "127.0.0.1" }], panel_user: "admin", panel_password: "node-pass" });
        const job = await finished(running, cookie, started.body.id);
        assert.deepEqual([job.state, job.error, job.targets[0].error], ["failed", expected, expected]);
        assert.equal(node.seen.length, 0, "nothing was sent to the node");
      });
    } finally { await node.close(); await github.close(); }
  }
});

test("a wrong login of the node's panel fails that node and says why; a node that reports another hash than the one sent is reported", async () => {
  const bad = await fakeNode({ password: "something-else" });
  try {
    await withServer(bad, null, async (running, cookie) => {
      const uploaded = await call(running, cookie, "POST", "/api/v1/admin/firmware/uploads", image(9), { "Content-Type": "application/octet-stream" });
      const started = await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "radar", source: "upload", upload_id: uploaded.body.id, targets: [{ address: "127.0.0.1" }], panel_user: "admin", panel_password: "node-pass" });
      const job = await finished(running, cookie, started.body.id);
      assert.deepEqual([job.state, job.targets[0].state, job.targets[0].error], ["failed", "failed", "panel_login_refused"]);
      assert.equal(bad.seen.length, 0);
    });
  } finally { await bad.close(); }
  const liar = await fakeNode({ lieAboutHash: true });
  try {
    await withServer(liar, null, async (running, cookie) => {
      const uploaded = await call(running, cookie, "POST", "/api/v1/admin/firmware/uploads", image(9), { "Content-Type": "application/octet-stream" });
      const started = await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "radar", source: "upload", upload_id: uploaded.body.id, targets: [{ address: "127.0.0.1" }], panel_user: "admin", panel_password: "node-pass" });
      assert.equal((await finished(running, cookie, started.body.id)).targets[0].error, "hash_mismatch");
    });
  } finally { await liar.close(); }
});

test("every kind of node can be updated; the checks of the routes refuse what is not allowed", async () => {
  const node = await fakeNode();
  try {
    await withServer(node, null, async (running, cookie) => {
      assert.equal((await call(running, "", "POST", "/api/v1/admin/firmware/probe", { addresses: [] })).status, 401);
      const text = await call(running, cookie, "POST", "/api/v1/admin/firmware/uploads", Buffer.from("not an image"), { "Content-Type": "application/octet-stream" });
      assert.deepEqual([text.status, text.body.error], [422, "bad_size"]);
      const notFirmware = Buffer.alloc(130 * 1024, 1);
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/uploads", notFirmware, { "Content-Type": "application/octet-stream" })).body.error, "not_firmware");
      const base = { source: "github", panel_user: "admin", panel_password: "x" };
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { ...base, kind: "toaster", targets: [{ address: "127.0.0.1" }] })).body.error, "unknown_kind");
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { ...base, kind: "hmi", targets: [{ address: "8.8.8.8" }] })).body.error, "invalid_address");
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { ...base, kind: "solar", targets: [] })).body.error, "invalid_address");
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "solar", source: "github", targets: [{ address: "127.0.0.1" }] })).body.error, "no_panel_login");
      assert.equal((await call(running, cookie, "POST", "/api/v1/admin/firmware/jobs", { kind: "electrical", source: "upload", upload_id: "nope", targets: [{ address: "127.0.0.1" }], panel_user: "a", panel_password: "b" })).body.error, "unknown_upload");
      assert.equal((await call(running, cookie, "GET", "/api/v1/admin/firmware/jobs/none")).status, 404);
    });
  } finally { await node.close(); }
});
