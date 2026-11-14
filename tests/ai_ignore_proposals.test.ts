// The two options of the observation service (both off by default) and the proposals of areas to ignore: the service proposes, an administrator accepts or rejects, nothing is applied by itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IgnoreProposals } from "../src/ignore_proposals.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const AI_TOKEN = "a".repeat(32);
const json = { "Content-Type": "application/json" };
const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret-pw", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };
const zone = { x: 0.1, y: 0.2, w: 0.3, h: 0.2 };

const call = async (running: Running, method: string, url: string, options: { bearer?: string; cookie?: string; body?: unknown } = {}) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};

async function withServer(run: (running: Running, cookie: string) => Promise<void>): Promise<void> {
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN });
  try {
    const configured = await call(running, "POST", "/api/v1/cameras/configure", { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: camera });
    assert.ok(configured.status < 300, `configure: ${configured.status}`);
    await run(running, await studioCookie(running.base));
  } finally { await running.stop(); }
}

const turn = (running: Running, cookie: string, change: Record<string, unknown>) => call(running, "PUT", "/api/v1/security/settings", { cookie, body: change });

test("both options start off; studying the pictures lowers the security, weighing the radars better does not", () => {
  assert.equal(SECURITY_DEFAULTS["ai.spatial"], false);
  assert.equal(SECURITY_DEFAULTS["ai.learn"], false);
  assert.equal(lowers("ai.spatial", false, true), false);
  assert.equal(lowers("ai.learn", false, true), true);
  assert.equal(lowers("ai.learn", true, false), false);
});

test("the context tells the options, both off until an administrator turns them on", async () => {
  await withServer(async (running, cookie) => {
    assert.deepEqual((await call(running, "GET", "/api/v1/ai/context", { bearer: AI_TOKEN })).body.options, { spatial: false, learn: false });
    assert.equal((await turn(running, cookie, { "ai.spatial": true })).status, 200);
    assert.deepEqual((await call(running, "GET", "/api/v1/ai/context", { bearer: AI_TOKEN })).body.options, { spatial: true, learn: false });
  });
});

test("while ai.learn is off a proposal is not kept and the list is empty", async () => {
  await withServer(async (running, cookie) => {
    const reply = await call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } });
    assert.deepEqual(reply.body, { stored: false, reason: "feature_off" });
    assert.deepEqual((await call(running, "GET", "/api/v1/ignore-proposals", { cookie })).body, { proposals: [] });
  });
});

test("the service token is required, the camera must exist and the proposal must be rectangles inside the picture", async () => {
  await withServer(async (running, cookie) => {
    assert.equal((await turn(running, cookie, { "ai.learn": true })).status, 200);
    const url = "/api/v1/ai/ignore-proposals";
    assert.equal((await call(running, "POST", url, { body: { camera_id: "cam-gate", zones: [zone] } })).status, 401);
    assert.equal((await call(running, "POST", url, { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } })).status, 401);
    assert.equal((await call(running, "POST", url, { bearer: AI_TOKEN, body: { camera_id: "nope", zones: [zone] } })).status, 404);
    for (const body of [{ camera_id: "cam-gate" }, { camera_id: "cam-gate", zones: [{ ...zone, w: 0 }] }, { camera_id: "cam-gate", zones: Array(17).fill(zone) }, { camera_id: "cam-gate", zones: [zone], extra: 1 }, { zones: [zone] }]) {
      assert.equal((await call(running, "POST", url, { bearer: AI_TOKEN, body })).status, 422, JSON.stringify(body));
    }
    assert.deepEqual((await call(running, "POST", url, { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [] } })).body, { stored: false, reason: "empty" });
  });
});

test("an administrator accepts a proposal: its rectangles join the areas the camera ignores and nothing was applied before", async () => {
  await withServer(async (running, cookie) => {
    assert.equal((await turn(running, cookie, { "ai.learn": true })).status, 200);
    running.app.context.ignoreZones.set("cam-gate", [{ x: 0, y: 0, w: 0.1, h: 0.1 }]);
    assert.deepEqual((await call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } })).body, { stored: true });
    assert.deepEqual(running.app.context.ignoreZones.get("cam-gate"), [{ x: 0, y: 0, w: 0.1, h: 0.1 }], "a proposal changes nothing");
    assert.deepEqual((await call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } })).body, { stored: false, reason: "unchanged" });
    const waiting = await call(running, "GET", "/api/v1/ignore-proposals", { cookie });
    assert.deepEqual(waiting.body, { proposals: [{ camera_id: "cam-gate", camera_name: "Gate", zones: [zone] }] });
    assert.equal((await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: { decision: "accept" } })).status === 200, false, "an operator token is not an administrator's session");
    const decided = await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { cookie, body: { decision: "accept" } });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.decision, "accept");
    assert.deepEqual(running.app.context.ignoreZones.get("cam-gate"), [{ x: 0, y: 0, w: 0.1, h: 0.1 }, zone]);
    assert.deepEqual((await call(running, "GET", "/api/v1/ignore-proposals", { cookie })).body, { proposals: [] });
    assert.match(fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8"), /ai\.ignore_proposal.*cam-gate.*accept/);
  });
});

test("a rejected proposal is dropped and the same rectangles are not proposed again", async () => {
  await withServer(async (running, cookie) => {
    assert.equal((await turn(running, cookie, { "ai.learn": true })).status, 200);
    const propose = () => call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } });
    await propose();
    assert.equal((await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { cookie, body: { decision: "reject" } })).status, 200);
    assert.deepEqual(running.app.context.ignoreZones.get("cam-gate"), []);
    assert.deepEqual((await propose()).body, { stored: false, reason: "rejected_before" });
    assert.deepEqual((await call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [{ ...zone, x: 0.5 }] } })).body, { stored: true });
  });
});

test("a decision needs a proposal, a clear word, and a room for the rectangles", async () => {
  await withServer(async (running, cookie) => {
    assert.equal((await turn(running, cookie, { "ai.learn": true })).status, 200);
    assert.equal((await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { cookie, body: { decision: "accept" } })).status, 404);
    assert.equal((await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { cookie, body: { decision: "apply" } })).status, 400);
    const full = Array.from({ length: 16 }, (_, index) => ({ x: index / 20, y: 0.9, w: 0.04, h: 0.05 }));
    running.app.context.ignoreZones.set("cam-gate", full);
    await call(running, "POST", "/api/v1/ai/ignore-proposals", { bearer: AI_TOKEN, body: { camera_id: "cam-gate", zones: [zone] } });
    assert.equal((await call(running, "POST", "/api/v1/ignore-proposals/cam-gate", { cookie, body: { decision: "accept" } })).status, 400);
    assert.equal(running.app.context.ignoreZones.get("cam-gate").length, 16);
    assert.equal(running.app.context.ignoreProposals.get("cam-gate")?.length, 1, "the proposal still waits");
  });
});

test("what waits survives a restart, and a deleted camera takes its proposal with it", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-proposals-")), "p.json");
  const first = new IgnoreProposals(file);
  first.propose("cam-a", [zone]);
  first.propose("cam-b", [zone]);
  first.decide("cam-b", false);
  const second = new IgnoreProposals(file);
  assert.deepEqual(second.list(), [{ camera_id: "cam-a", zones: [zone] }]);
  assert.deepEqual(second.propose("cam-b", [zone]), { stored: false, reason: "rejected_before" });
  second.forget("cam-a");
  assert.deepEqual(new IgnoreProposals(file).list(), []);
});
