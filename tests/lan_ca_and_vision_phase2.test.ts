import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecuritySettings, SecuritySettingsInvalid, lowers } from "../src/security_settings.js";
import { startServer, studioCookie } from "./helpers.js";

const settings = () => new SecuritySettings(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-sec-")), "security-settings.json"));

test("the LAN CA option and the personal-data features of the vision service are off by default", () => {
  const values = settings().effective;
  for (const key of ["network.lan_ca", "vision.semantic_search", "vision.plates", "vision.faces", "vision.semantic_search_ack", "vision.plates_ack", "vision.faces_ack"] as const) assert.equal(values[key], false, key);
});

test("a personal-data feature cannot be on without its acknowledgement, in one request or in two", () => {
  const store = settings();
  assert.throws(() => store.update({ "vision.plates": true }), SecuritySettingsInvalid);
  assert.equal(store.effective["vision.plates"], false);
  assert.deepEqual(store.update({ "vision.plates": true, "vision.plates_ack": true }), { "vision.plates": true, "vision.plates_ack": true });
  assert.throws(() => store.update({ "vision.plates_ack": false }), SecuritySettingsInvalid, "the notice cannot be taken back while the feature is on");
  store.update({ "vision.plates": false, "vision.plates_ack": false });
  assert.equal(store.effective["vision.plates"], false);
});

test("turning these options on lowers the security, reading the notice does not", () => {
  assert.equal(lowers("network.lan_ca", false, true), true);
  assert.equal(lowers("network.lan_ca", true, false), false);
  assert.equal(lowers("vision.faces", false, true), true);
  assert.equal(lowers("vision.faces_ack", false, true), false);
});

test("the CA route answers 404 while off, serves a public certificate when on, and never a key", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "armor-ca-"));
  const good = path.join(folder, "ca.crt"), bad = path.join(folder, "bad.pem");
  fs.writeFileSync(good, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(bad, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
  for (const [file, expected] of [[good, 200], [bad, 404]] as const) {
    const running = await startServer({ ARMOR_LAN_CA_FILE: file });
    try {
      const cookie = await studioCookie(running.base);
      assert.equal((await fetch(`${running.base}/api/v1/security/lan-ca`, { headers: { cookie } })).status, 404, "off by default");
      const put = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ "network.lan_ca": true }) });
      assert.equal(put.status, 200);
      const reply = await fetch(`${running.base}/api/v1/security/lan-ca`, { headers: { cookie } });
      assert.equal(reply.status, expected);
      if (expected === 200) assert.match(await reply.text(), /BEGIN CERTIFICATE/);
      else assert.doesNotMatch(await reply.text(), /PRIVATE KEY/);
    } finally { await running.stop(); }
  }
});

test("the retention of snapshots and of recordings starts at the environment and an administrator changes each one on its own", async () => {
  const store = settings();
  assert.equal(store.effective["media.retention_snapshot_days"], 0);
  assert.throws(() => store.update({ "media.retention_snapshot_days": 3651 }), SecuritySettingsInvalid);
  assert.throws(() => store.update({ "media.retention_recording_days": -1 }), SecuritySettingsInvalid);
  assert.throws(() => store.update({ "media.retention_recording_days": 1.5 }), SecuritySettingsInvalid);
  assert.equal(lowers("media.retention_snapshot_days", 30, 3), false);
  const running = await startServer({ ARMOR_MEDIA_RETENTION_SNAPSHOT_DAYS: "90" });
  try {
    const cookie = await studioCookie(running.base);
    const headers = { cookie, "content-type": "application/json" };
    const read = async () => (await (await fetch(`${running.base}/api/v1/security/settings`, { headers })).json() as { settings: Record<string, number> }).settings;
    assert.equal((await read())["media.retention_snapshot_days"], 90, "where it starts");
    assert.equal((await read())["media.retention_recording_days"], 0);
    const put = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "media.retention_snapshot_days": 7, "media.retention_recording_days": 14 }) });
    assert.equal(put.status, 200);
    assert.equal((await read())["media.retention_snapshot_days"], 7);
    assert.equal((await read())["media.retention_recording_days"], 14);
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "media.retention_snapshot_days": 99999 }) })).status, 400);
  } finally { await running.stop(); }
});
