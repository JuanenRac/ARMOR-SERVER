// The optional token of the live vision service: given by the environment or by a file (never in the settings), sent only to the service the settings name, never shown in the settings,
// the audit trail or an error, and shown to Studio only as "there is one" or "there is none".
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fetchVisionService, heatmap } from "../src/reports.js";
import { startServer, studioCookie, tempDir, testConfig } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const TOKEN = "vision-token-0123456789abcdefXYZ";
const MAP = { schema: "armor.vision.heatmap/v1", camera_id: "cam-front", cols: 2, rows: 1, accepted_positions: 1, rejected_positions: 0, total: 1, max: 1, weights: [[1, 0]], normalized: [[1, 0]], contains_images: false };

async function service(requireToken?: string): Promise<{ port: number; seen: Array<string | undefined>; close: () => Promise<void> }> {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (requireToken && request.headers.authorization !== `Bearer ${requireToken}`) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(MAP));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("characterization: with no token the request carries no Authorization header and the settings say there is none", async () => {
  const fake = await service();
  const running = await startServer({ ARMOR_VISION_SERVICE_URL: `http://127.0.0.1:${fake.port}` });
  try {
    const admin = await studioCookie(running.base);
    await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "vision.heatmap": true }) });
    assert.equal((await fetch(`${running.base}/api/v1/vision/heatmap`, { headers: { cookie: admin } })).status, 200);
    assert.deepEqual(fake.seen, [undefined]);
    const view = (await (await fetch(`${running.base}/api/v1/security/settings`, { headers: { cookie: admin } })).json()) as { settings: Record<string, unknown> };
    assert.equal(view.settings["vision.service_token_set"], false);
  } finally { await running.stop(); await fake.close(); }
});

test("the token goes to the service in the settings and only there, and the settings, the audit trail and the errors never show it", async () => {
  const fake = await service(TOKEN);
  const file = path.join(tempDir(), "vision.token");
  fs.writeFileSync(file, `${TOKEN}\n`);
  for (const env of [{ ARMOR_VISION_SERVICE_TOKEN: TOKEN }, { ARMOR_VISION_SERVICE_TOKEN_FILE: file }] as Array<Record<string, string>>) {
    const running = await startServer({ ARMOR_VISION_SERVICE_URL: `http://127.0.0.1:${fake.port}`, ...env });
    try {
      const admin = await studioCookie(running.base);
      const set = (body: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(body) });
      assert.equal((await set({ "vision.heatmap": true })).status, 200);
      const answer = await fetch(`${running.base}/api/v1/vision/heatmap`, { headers: { cookie: admin } });
      assert.equal(answer.status, 200);
      assert.equal(fake.seen.at(-1), `Bearer ${TOKEN}`);
      // read only: Studio can see that there is one, and cannot set it or turn it off
      const view = await (await fetch(`${running.base}/api/v1/security/settings`, { headers: { cookie: admin } })).text();
      assert.equal((JSON.parse(view) as { settings: Record<string, unknown> }).settings["vision.service_token_set"], true);
      assert.doesNotMatch(view, new RegExp(TOKEN));
      assert.equal((await set({ "vision.service_token_set": false })).status, 400);
      assert.equal((await set({ "vision.service_token": TOKEN })).status, 400, "there is no such setting to send it to");
      assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { headers: { cookie: admin } }).then(r => r.text())).includes(TOKEN), false);
      // every other place
      await set({ "vision.service_url": `http://127.0.0.1:${fake.port}` });
      const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
      assert.doesNotMatch(audit, new RegExp(TOKEN));
      for (const name of fs.readdirSync(running.config.dataDir)) assert.doesNotMatch(fs.readFileSync(path.join(running.config.dataDir, name), "utf8"), new RegExp(TOKEN), name);
    } finally { await running.stop(); }
  }
  await fake.close();
});

test("a service that does not accept the token is a 502 that says nothing, and the token is not sent when the address is refused", async () => {
  const fake = await service("another-token-0123456789abcdefg");
  const refused = await service();
  const running = await startServer({ ARMOR_VISION_SERVICE_URL: `http://127.0.0.1:${fake.port}`, ARMOR_VISION_SERVICE_TOKEN: TOKEN });
  try {
    const admin = await studioCookie(running.base);
    const set = (body: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(body) });
    await set({ "vision.heatmap": true });
    const answer = await fetch(`${running.base}/api/v1/vision/heatmap`, { headers: { cookie: admin } });
    assert.equal(answer.status, 502);
    const text = await answer.text();
    assert.deepEqual(JSON.parse(text), { error: "heatmap_failed" });
    assert.doesNotMatch(text, new RegExp(TOKEN));
    // an address that is not this machine while the remote switch is off: nothing leaves, so the token does not either
    assert.equal((await set({ "vision.service_url": "http://192.168.0.50:8765" })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/vision/heatmap`, { headers: { cookie: admin } })).status, 503);
    assert.deepEqual(refused.seen, []);
  } finally { await running.stop(); await fake.close(); await refused.close(); }
});

test("heatmap(): the token is handed to the fetch only when there is one, and a 401 or 403 is never passed on", async () => {
  const asked: Array<string | undefined> = [];
  const make = (status: number) => async (_url: string, _t: number, _m: number, token?: string) => { asked.push(token); return { status, type: "text/plain", body: Buffer.from("secret detail") }; };
  assert.equal((await heatmap({ url: "http://127.0.0.1:8765", remote: false, fetch: make(200), token: "" }, { format: "json", scale: "16" })).status, 502);
  await heatmap({ url: "http://127.0.0.1:8765", remote: false, fetch: make(401), token: TOKEN }, { format: "json", scale: "16" });
  const forbidden = await heatmap({ url: "http://127.0.0.1:8765", remote: false, fetch: make(403), token: TOKEN }, { format: "json", scale: "16" });
  assert.deepEqual(forbidden, { status: 502, json: { error: "heatmap_failed" } });
  assert.deepEqual(asked, [undefined, TOKEN, TOKEN]);
  assert.equal(typeof fetchVisionService, "function");
});

test("the token is checked when the server starts: given twice, unreadable, too short or with odd characters is an error that does not repeat it", () => {
  const dir = tempDir();
  const file = path.join(dir, "token");
  fs.writeFileSync(file, TOKEN);
  assert.equal(testConfig({ ARMOR_VISION_SERVICE_TOKEN_FILE: file }).visionServiceToken, TOKEN);
  assert.equal(testConfig({}).visionServiceToken, "");
  const bad: Array<[Record<string, string>, RegExp]> = [
    [{ ARMOR_VISION_SERVICE_TOKEN: TOKEN, ARMOR_VISION_SERVICE_TOKEN_FILE: file }, /once/],
    [{ ARMOR_VISION_SERVICE_TOKEN_FILE: path.join(dir, "missing") }, /cannot be read/],
    [{ ARMOR_VISION_SERVICE_TOKEN: "too-short-token" }, /24 to 200/],
    [{ ARMOR_VISION_SERVICE_TOKEN: `${TOKEN} with spaces` }, /24 to 200/],
    [{ ARMOR_VISION_SERVICE_TOKEN: "x".repeat(201) }, /24 to 200/],
  ];
  for (const [env, pattern] of bad) {
    assert.throws(() => testConfig(env), (error: Error) => pattern.test(error.message) && !error.message.includes(TOKEN) && !error.message.includes("too-short-token"), JSON.stringify(Object.keys(env)));
  }
});
