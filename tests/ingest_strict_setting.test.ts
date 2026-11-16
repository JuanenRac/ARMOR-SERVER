import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nodeTokenFor, SharedTokenWatch } from "../src/http/node_token.js";
import { lowers, SECURITY_DEFAULTS, SecuritySettings } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const NEW_KEYS = ["nodes.ingest_strict", "solar.battery_write", "admin.cm5_update"] as const;

test("the three switches that used to live only in the environment are off by default and lowering them is told", () => {
  for (const key of NEW_KEYS) assert.equal(SECURITY_DEFAULTS[key], false, key);
  assert.equal(lowers("nodes.ingest_strict", true, false), true, "taking the shared token again is the loss");
  assert.equal(lowers("nodes.ingest_strict", false, true), false);
  assert.equal(lowers("solar.battery_write", false, true), true, "opening a way to write to batteries is the loss");
  assert.equal(lowers("solar.battery_write", true, false), false);
  assert.equal(lowers("admin.cm5_update", false, true), true);
  assert.equal(lowers("admin.cm5_update", true, false), false);
});

test("the environment only says where they start: a value is written to the file once someone sets it", () => {
  const file = path.join(tempDir(), "security-settings.json");
  const started = new SecuritySettings(file, { initial: { "nodes.ingest_strict": true, "solar.battery_write": true, "admin.cm5_update": true } });
  for (const key of NEW_KEYS) assert.equal(started.get(key), true, key);
  started.update({ "alarm.config_hash": false });   // an unrelated change must not freeze the environment's start
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
  for (const key of NEW_KEYS) assert.equal(key in stored.settings, false, `${key} is not written until it is set`);
  started.update({ "nodes.ingest_strict": false });
  assert.equal(new SecuritySettings(file, { initial: { "nodes.ingest_strict": true } }).get("nodes.ingest_strict"), false, "what was set in Studio wins over the environment");
});

test("the shared-token watch lists the boards that still use it and forgets those that got their own", () => {
  const first: string[] = [];
  const watch = new SharedTokenWatch(node => first.push(node));
  watch.note("radar-1", "shared", 1_000);
  watch.note("radar-1", "shared", 2_000);
  watch.note("hmi-1", "shared", 3_000);
  watch.note("hmi-1", null, 4_000);
  watch.note("../x", "shared", 5_000);
  assert.deepEqual(first, ["radar-1", "hmi-1", "(no node id)"], "told once for each");
  assert.deepEqual(watch.list().map(item => [item.node_id, item.messages]), [["(no node id)", 1], ["hmi-1", 1], ["radar-1", 2]]);
  watch.note("hmi-1", "node", 6_000);
  assert.deepEqual(watch.list().map(item => item.node_id), ["(no node id)", "radar-1"]);
  const small = new SharedTokenWatch(() => undefined, 2);
  for (const id of ["a", "b", "c"]) small.note(id, "shared", 1);
  assert.equal(small.list().length, 2, "the list never grows without a limit");
});

test("through the routes: the shared token works until the strict switch is on, and the settings name the nodes that used it", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ingest = (token: string) => fetch(`${running.base}/api/v1/solar`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ node_id: "gw-1" }) });
    assert.notEqual((await ingest(SECRETS.ARMOR_INGEST_TOKEN)).status, 401, "off by default: the boards in the field keep working");
    const listed = async () => ((await (await call("GET", "/api/v1/security/settings")).json()) as { ingest_shared_token_nodes: Array<{ node_id: string }> }).ingest_shared_token_nodes.map(item => item.node_id);
    assert.deepEqual(await listed(), ["gw-1"]);
    assert.equal((await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
    assert.equal((await call("PUT", "/api/v1/security/settings", { "nodes.ingest_strict": true })).status, 200);
    assert.equal((await ingest(SECRETS.ARMOR_INGEST_TOKEN)).status, 401);
    assert.notEqual((await ingest(nodeTokenFor(SECRETS.ARMOR_INGEST_TOKEN, "gw-1"))).status, 401, "the node's own token is still taken");
    assert.deepEqual(await listed(), [], "a node that speaks with its own token leaves the list");
    assert.match(fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8"), /nodes\.ingest_strict.*false -> true/);
  } finally { await running.stop(); }
});

test("through the routes: writing to batteries and updating the machine are switched from the settings, off to begin with", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(((await (await call("GET", "/api/v1/solar/battery-ops")).json()) as { enabled: boolean }).enabled, false);
    assert.deepEqual(await (await call("GET", "/api/v1/admin/machine-update")).json(), { enabled: false, reason: "switched_off" });
    assert.equal((await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
    assert.equal((await call("PUT", "/api/v1/security/settings", { "solar.battery_write": true, "admin.cm5_update": true })).status, 200);
    assert.equal(((await (await call("GET", "/api/v1/solar/battery-ops")).json()) as { enabled: boolean }).enabled, true);
    assert.notDeepEqual(await (await call("GET", "/api/v1/admin/machine-update")).json(), { enabled: false, reason: "switched_off" });
    assert.equal((await call("PUT", "/api/v1/security/settings", { "solar.battery_write": false })).status, 200);
    assert.equal(((await (await call("GET", "/api/v1/solar/battery-ops")).json()) as { enabled: boolean }).enabled, false);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /solar\.battery_write.*false -> true \(lowers the security\)/);
  } finally { await running.stop(); }
});

test("the variables still say where the switches start", async () => {
  const running = await startServer({ ARMOR_INGEST_STRICT: "1", ARMOR_BATTERY_WRITE: "1", ARMOR_CM5_UPDATE: "1" });
  try {
    for (const key of NEW_KEYS) assert.equal(running.app.context.securitySettings.get(key), true, key);
  } finally { await running.stop(); }
});
