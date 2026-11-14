// The one-use code that sets up an app from a QR: off by default (404), five minutes, one use, nothing secret, and the same 404 for every kind of bad code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startServer, studioCookie, tempDir, type Running } from "./helpers.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { caFingerprint, cleanOrigin, ENROLMENT_CODE_TTL_MS } from "../src/routes/enrolment.js";

const json = { "Content-Type": "application/json" };
const ask = (running: Running, cookie: string, body: unknown) => fetch(`${running.base}/api/v1/admin/enrolment-code`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify(body) })
  .then(async reply => ({ status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, unknown> }));
const read = (running: Running, code: string) => fetch(`${running.base}/api/v1/enrolment/${code}`)
  .then(async reply => ({ status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, unknown> }));
const setting = (running: Running, cookie: string, change: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify(change) });
const ORIGIN = "https://armor.example.org:18080";

/** A public test certificate (a self-signed authority made for this test; its key was thrown away) and its SHA-256 as OpenSSL prints it. */
const CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBczCCARqgAwIBAgIUDlMnOmtPnjXrfdOCU1RWau+JOpEwCgYIKoZIzj0EAwIw",
  "HzEdMBsGA1UEAwwUVGVzdCBsb2NhbCBhdXRob3JpdHkwIBcNMjYxMTE0MDMwMDM0",
  "WhgPMjEyNjEwMjEwMzAwMzRaMB8xHTAbBgNVBAMMFFRlc3QgbG9jYWwgYXV0aG9y",
  "aXR5MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5Y8CNqbS7HEM/M2Qo/Zl3c+c",
  "6Y/IF2Ee3Zx6BranlIcysA+6T0TeAPJGQtSY0v4CrKmlqdfAkU1A+pQTwO8pmKMy",
  "MDAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUrpCwCkxORGzzKXIi5zvQEYrV",
  "aQkwCgYIKoZIzj0EAwIDRwAwRAIhAOvCt3t68i5906Eyi/RMR9lr+1ScZdDmHi5s",
  "5eQrFRNPAh9BqWxdfSa16cB51IZNsMjOOdFNSx7i2hOrILe0mwIU",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const CERTIFICATE_SHA256 = "79CA85E16340BBC46012DEFE4CFDFF30287C1F0FA5F8DC26B395D15E498E8A7A".toLowerCase();

test("the option is off by default and turning it on is not a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["client.enrolment_code"], false);
  assert.equal(lowers("client.enrolment_code", false, true), false);
  assert.equal(lowers("client.enrolment_code", true, false), false);
});

test("while the option is off both routes answer 404 as if they did not exist", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await ask(running, cookie, { origin: ORIGIN })).status, 404);
    assert.equal((await read(running, "A".repeat(32))).status, 404);
  } finally { await running.stop(); }
});

test("an administrator gets a code, the phone reads the facts with it once, and the facts hold no secret", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await setting(running, cookie, { "client.enrolment_code": true })).status, 200);
    const made = await ask(running, cookie, { origin: ORIGIN });
    assert.equal(made.status, 200);
    const code = String(made.body.code);
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(made.body.origin, ORIGIN);
    assert.equal(made.body.ca_fingerprint, null, "no authority file is configured");
    const ends = Date.parse(String(made.body.expires_at)) - Date.now();
    assert.ok(ends > ENROLMENT_CODE_TTL_MS - 5000 && ends <= ENROLMENT_CODE_TTL_MS, "five minutes");
    const first = await read(running, code);
    assert.deepEqual({ status: first.status, body: first.body }, { status: 200, body: { origin: ORIGIN, ca_fingerprint: null } });
    assert.equal((await read(running, code)).status, 404, "a second reading is refused");
    assert.ok(!JSON.stringify(first.body).includes(code), "the code is not repeated");
  } finally { await running.stop(); }
});

test("a code that ended, a wrong one and one of the wrong shape all answer the same 404", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.enrolment_code": true });
    const code = String((await ask(running, cookie, { origin: ORIGIN })).body.code);
    const real = Date.now;
    let ended: { status: number; body: Record<string, unknown> };
    try {
      Date.now = () => real() + ENROLMENT_CODE_TTL_MS + 1;
      ended = await read(running, code);
    } finally { Date.now = real; }
    const wrong = await read(running, "B".repeat(32));
    const shape = await read(running, "x");
    assert.deepEqual([ended.status, wrong.status, shape.status], [404, 404, 404]);
    assert.deepEqual(ended.body, wrong.body);
    assert.deepEqual(wrong.body, shape.body);
  } finally { await running.stop(); }
});

test("the request needs an administrator and an https address", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.enrolment_code": true });
    assert.equal((await ask(running, "", { origin: ORIGIN })).status, 401);
    const plain = await ask(running, cookie, { origin: "http://armor.local" });
    assert.deepEqual({ status: plain.status, code: plain.body.code }, { status: 400, code: "invalid_origin" });
    assert.equal((await ask(running, cookie, { origin: "https://user:pass@armor.local" })).status, 400);
    assert.equal((await ask(running, cookie, { origin: 5 })).status, 400);
  } finally { await running.stop(); }
});

test("too many wrong tries from one address are slowed with 429", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.enrolment_code": true });
    const seen = new Set<number>();
    for (let n = 0; n < 14; n += 1) seen.add((await read(running, "C".repeat(32))).status);
    assert.deepEqual([...seen].sort(), [404, 429]);
  } finally { await running.stop(); }
});

test("the origin and the fingerprint are read from what they are", () => {
  assert.equal(cleanOrigin("https://armor.local:18080/path?x=1"), "https://armor.local:18080");
  assert.equal(cleanOrigin("http://armor.local"), null);
  assert.equal(cleanOrigin("not a url"), null);
  assert.equal(cleanOrigin(undefined), null);
  const dir = tempDir();
  assert.equal(caFingerprint(null), null);
  assert.equal(caFingerprint(path.join(dir, "missing.crt")), null);
  const withKey = path.join(dir, "key.pem");
  fs.writeFileSync(withKey, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
  assert.equal(caFingerprint(withKey), null, "a file with a private key names nothing");
  const garbage = path.join(dir, "bad.crt");
  fs.writeFileSync(garbage, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  assert.equal(caFingerprint(garbage), null);
  const good = path.join(dir, "ca.crt");
  fs.writeFileSync(good, CERTIFICATE);
  assert.equal(caFingerprint(good), CERTIFICATE_SHA256);
});

test("with a local authority the code carries its fingerprint, and a reading gives it to the phone", async () => {
  const file = path.join(tempDir(), "ca.crt");
  fs.writeFileSync(file, CERTIFICATE);
  const running = await startServer({ ARMOR_LAN_CA_FILE: file });
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.enrolment_code": true });
    const made = await ask(running, cookie, { origin: ORIGIN });
    assert.equal(made.body.ca_fingerprint, CERTIFICATE_SHA256);
    assert.deepEqual((await read(running, String(made.body.code))).body, { origin: ORIGIN, ca_fingerprint: CERTIFICATE_SHA256 });
  } finally { await running.stop(); }
});

test("without an origin in the request the server names its own host over https", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.enrolment_code": true });
    const made = await ask(running, cookie, {});
    assert.equal(made.status, 200);
    assert.match(String(made.body.origin), /^https:\/\/127\.0\.0\.1:\d+$/);
  } finally { await running.stop(); }
});
