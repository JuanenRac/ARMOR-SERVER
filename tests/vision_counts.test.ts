// The crossings of the counting lines, asked of the live service of ARMOR-VISION: behind the same switch as the heat map (off by default), for administrators and operators only, the answer
// kept to numbers under the schema of the service, and every ask written in the audit trail.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { lineCounts, type FetchVision, type VisionAnswer } from "../src/reports.js";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const COUNTS = { schema: "armor.vision.counts/v1", cameras: { "cam-front": { gate: { to_left: 3, to_right: 5 }, path: { to_left: 0, to_right: 0 } } } };
const reply = (body: unknown, status = 200, type = "application/json"): VisionAnswer => ({ status, type, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const deps = (fetch: FetchVision, extra: Record<string, unknown> = {}) => ({ url: "http://127.0.0.1:8765", remote: false, fetch, ...extra });

test("the counts are passed on as numbers under their camera and line", async () => {
  const asked: string[] = [];
  const answer = await lineCounts(deps(async url => { asked.push(url); return reply(COUNTS); }));
  assert.deepEqual(asked, ["http://127.0.0.1:8765/counts"]);
  assert.deepEqual(answer, { status: 200, json: { cameras: COUNTS.cameras } });
  assert.deepEqual(await lineCounts(deps(async () => reply({ schema: "armor.vision.counts/v1", cameras: {} }))), { status: 200, json: { cameras: {} } });
});

test("what is not set up never leaves, and what the service says wrong is not passed on", async () => {
  const never: FetchVision = async () => { throw new Error("must not be asked"); };
  assert.deepEqual(await lineCounts(deps(never, { url: "" })), { status: 503, json: { error: "counts_not_configured" } });
  assert.deepEqual(await lineCounts(deps(never, { url: "http://192.168.0.50:8765" })), { status: 503, json: { error: "counts_not_configured" } });
  assert.equal((await lineCounts(deps(async () => null))).status, 502);
  assert.deepEqual(await lineCounts(deps(async () => reply("not found\n", 404, "text/plain"))), { status: 404, json: { error: "counts_pipeline_off" } });
  const wrong: unknown[] = [
    "<html>", { schema: "other", cameras: {} }, { schema: COUNTS.schema }, { ...COUNTS, extra: 1 }, { schema: COUNTS.schema, cameras: [] },
    { schema: COUNTS.schema, cameras: { "a/b": {} } }, { schema: COUNTS.schema, cameras: { cam: { "bad line": { to_left: 1, to_right: 1 } } } },
    { schema: COUNTS.schema, cameras: { cam: { gate: { to_left: 1.5, to_right: 1 } } } }, { schema: COUNTS.schema, cameras: { cam: { gate: { to_left: -1, to_right: 1 } } } },
    { schema: COUNTS.schema, cameras: { cam: { gate: { to_left: "1", to_right: 1 } } } }, { schema: COUNTS.schema, cameras: { cam: { gate: { to_left: 1, to_right: 1, label: "person" } } } },
    { schema: COUNTS.schema, cameras: { cam: { gate: { to_left: 1 } } } }, { schema: COUNTS.schema, cameras: { cam: { gate: null } } },
  ];
  for (const body of wrong) assert.deepEqual(await lineCounts(deps(async () => reply(body))), { status: 502, json: { error: "counts_failed" } }, JSON.stringify(body));
  assert.equal((await lineCounts(deps(async () => reply(COUNTS, 200, "text/html")))).status, 502);
  assert.equal((await lineCounts(deps(async () => reply(COUNTS, 500)))).status, 502);
  assert.equal((await lineCounts(deps(async () => reply(COUNTS, 302)))).status, 502);
});

test("the route is off with the switch, for administrators and operators only, takes no query, and every ask is audited", async () => {
  const asked: string[] = [];
  const running = await startServer({ ARMOR_VISION_SERVICE_URL: "http://127.0.0.1:8765" }, { fetchVision: async url => { asked.push(url); return reply(COUNTS); } });
  try {
    const admin = await studioCookie(running.base);
    const url = `${running.base}/api/v1/vision/counts`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { cookie: admin } })).status, 404);   // the switch is off
    assert.deepEqual(asked, []);
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "u-viewer", password: "viewer-password-123", role: "viewer" }) });
    assert.equal(made.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "u-viewer", password: "viewer-password-123" }) });
    const viewer = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    assert.equal((await fetch(url, { headers: { cookie: viewer } })).status, 403);
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "vision.heatmap": true }) })).status, 200);
    const done = await fetch(url, { headers: { cookie: admin } });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { cameras: COUNTS.cameras });
    assert.deepEqual(asked, ["http://127.0.0.1:8765/counts"]);
    assert.equal((await fetch(`${url}?camera=cam-front`, { headers: { cookie: admin } })).status, 400);
    assert.match(fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8"), /report\.vision_counts/);
  } finally { await running.stop(); }
});
