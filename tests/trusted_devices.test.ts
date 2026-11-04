import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanPublicKey, signedText, TRUSTED_PER_USER, TrustedDevices } from "../src/trusted_devices.js";
import { startServer, studioCookie, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const call = async (running: Running, cookie: string | undefined, method: string, url: string, body?: unknown) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, headers: reply.headers, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};
const phone = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { key: publicKey.export({ format: "der", type: "spki" }).toString("base64"), sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), privateKey).toString("base64") };
};

test("only an ECDSA P-256 public key is taken, and a phone is registered once per key and person", () => {
  const store = new TrustedDevices(path.join(tempDir(), "trusted.json"));
  const a = phone();
  assert.equal(cleanPublicKey(a.key), a.key);
  assert.equal(cleanPublicKey("not a key at all, not a key at all, not a key at all"), undefined);
  assert.equal(cleanPublicKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64")), undefined);
  assert.equal(store.register("u1", "  ", a.key), "bad_name");
  assert.equal(store.register("u1", "Pixel", "AAAA"), "bad_key");
  const first = store.register("u1", "Pixel", a.key);
  assert.ok(typeof first === "object");
  assert.equal(store.register("u1", "Other name", a.key), first, "the same key again is the same phone");
  for (let i = 1; i < TRUSTED_PER_USER; i += 1) assert.ok(typeof store.register("u1", `p${i}`, phone().key) === "object");
  assert.equal(store.register("u1", "one too many", phone().key), "limit");
  assert.equal(store.list("u1").length, TRUSTED_PER_USER);
  assert.equal(new TrustedDevices(path.join(tempDir(), "x.json")).list().length, 0);
});

test("a challenge is good once, for one phone, and a wrong or late signature gives nothing", () => {
  let now = 1_000_000;
  const file = path.join(tempDir(), "trusted.json");
  const store = new TrustedDevices(file, () => now);
  const a = phone(), b = phone();
  const da = store.register("u1", "A", a.key) as { id: string }, db = store.register("u1", "B", b.key) as { id: string };
  assert.equal(store.challenge("0".repeat(24)), undefined);
  let challenge = store.challenge(da.id)!;
  assert.equal(store.prove(da.id, challenge, b.sign(signedText(da.id, challenge))), undefined, "signed by another key");
  assert.equal(store.prove(da.id, challenge, a.sign(signedText(da.id, challenge))), undefined, "the challenge was used up by the failed try");
  challenge = store.challenge(da.id)!;
  assert.equal(store.prove(db.id, challenge, a.sign(signedText(db.id, challenge))), undefined, "another phone's challenge is not this one's");
  challenge = store.challenge(da.id)!;
  assert.equal(store.prove(da.id, challenge, a.sign(signedText(db.id, challenge))), undefined, "signed for another device id");
  challenge = store.challenge(da.id)!;
  now += 61_000;
  assert.equal(store.prove(da.id, challenge, a.sign(signedText(da.id, challenge))), undefined, "too late");
  challenge = store.challenge(da.id)!;
  assert.ok(store.prove(da.id, challenge, a.sign(signedText(da.id, challenge))));
  assert.equal(store.prove(da.id, challenge, a.sign(signedText(da.id, challenge))), undefined, "not twice");
  assert.ok(new TrustedDevices(file).get(da.id)?.lastUsedAt, "kept on disk");
});

test("the routes answer 404 while the option is off, and register, renew and revoke while it is on", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const a = phone();
    assert.equal((await call(running, cookie, "POST", "/api/v1/devices/trust", { name: "Pixel", public_key: a.key })).status, 404);
    assert.equal((await call(running, undefined, "POST", "/api/v1/devices/trust/challenge", { id: "x" })).status, 404);
    assert.equal((await call(running, cookie, "GET", "/api/v1/devices/trust")).body.enabled, false);
    assert.equal((await call(running, undefined, "GET", "/api/v1/devices/trust")).status, 401);
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "client.trusted_devices": true, "client.trusted_session_h": 2 })).status, 200);
    assert.equal((await call(running, cookie, "POST", "/api/v1/devices/trust", { name: "Pixel", public_key: "AAAA" })).status, 400);
    const added = await call(running, cookie, "POST", "/api/v1/devices/trust", { name: "Pixel", public_key: a.key });
    assert.equal(added.status, 201);
    const id = added.body.id as string;
    assert.equal((await call(running, cookie, "GET", "/api/v1/devices/trust")).body.devices.length, 1);
    assert.equal((await call(running, undefined, "POST", "/api/v1/devices/trust/session", { id, challenge: "x", signature: "AAAAAAAAAA" })).status, 401);
    const asked = await call(running, undefined, "POST", "/api/v1/devices/trust/challenge", { id });
    assert.equal(asked.status, 200);
    const opened = await call(running, undefined, "POST", "/api/v1/devices/trust/session", { id, challenge: asked.body.challenge, signature: a.sign(signedText(id, asked.body.challenge)) });
    assert.equal(opened.status, 201);
    const cookie2 = (opened.headers.getSetCookie()[0] ?? "").split(";")[0];
    assert.ok(cookie2);
    assert.equal((await call(running, undefined, "GET", "/api/v1/studio/session")).body.authenticated, false);
    assert.equal((await call(running, cookie2, "GET", "/api/v1/studio/session")).body.authenticated, true);
    assert.ok(Math.abs(new Date(opened.body.expiresAt).getTime() - Date.now() - 2 * 3_600_000) < 60_000, "client.trusted_session_h decides the length");
    assert.equal((await call(running, cookie, "DELETE", `/api/v1/devices/trust/${id}`)).status, 204);
    assert.equal((await call(running, undefined, "POST", "/api/v1/devices/trust/challenge", { id })).status, 404);
    assert.equal((await call(running, cookie, "DELETE", `/api/v1/devices/trust/${id}`)).status, 404);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /devices\.trust\.add/);
    assert.match(audit, /devices\.trust\.session/);
    assert.doesNotMatch(audit, new RegExp(a.key.slice(0, 30).replace(/[+/]/g, ".")), "the key is not written in the audit");
  } finally { await running.stop(); }
});
