import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PublicLoginLimiter, decidePublicRequest, publicAccessProblems } from "../src/public_access.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

const good = { ownTls: true, proxyTls: false, controlTokenLength: 32, studioPasswordLength: 12, cookieSecure: true };

test("the facts that stop the server taking requests from the Internet are named one by one", () => {
  assert.deepEqual(publicAccessProblems(good), []);
  assert.deepEqual(publicAccessProblems({ ...good, ownTls: false, proxyTls: false }), ["tls_missing"]);
  assert.deepEqual(publicAccessProblems({ ...good, ownTls: false, proxyTls: true }), []);
  assert.deepEqual(publicAccessProblems({ ...good, controlTokenLength: 31 }), ["control_token_short"]);
  assert.deepEqual(publicAccessProblems({ ...good, studioPasswordLength: 11 }), ["password_short"]);
  assert.deepEqual(publicAccessProblems({ ...good, cookieSecure: false }), ["cookie_not_secure"]);
  assert.deepEqual(publicAccessProblems({ ownTls: false, proxyTls: false, controlTokenLength: 0, studioPasswordLength: 0, cookieSecure: false }), ["tls_missing", "control_token_short", "password_short", "cookie_not_secure"]);
});

test("a request from the house is never touched; one from outside needs the option, no problems and TLS, in that order", () => {
  assert.deepEqual(decidePublicRequest({ remote: false, secure: false, enabled: false, problems: ["tls_missing"] }), { allow: true });
  assert.deepEqual(decidePublicRequest({ remote: true, secure: true, enabled: false, problems: [] }), { allow: false, status: 403, error: "public_access_off" });
  assert.deepEqual(decidePublicRequest({ remote: true, secure: true, enabled: true, problems: ["password_short"] }), { allow: false, status: 403, error: "public_access_unsafe", problems: ["password_short"] });
  assert.deepEqual(decidePublicRequest({ remote: true, secure: false, enabled: true, problems: [] }), { allow: false, status: 403, error: "tls_required" });
  assert.deepEqual(decidePublicRequest({ remote: true, secure: true, enabled: true, problems: [] }), { allow: true });
});

test("failed sign-ins close an address for the window, and only that address, and a success opens it again", () => {
  let now = 1_000_000;
  const limiter = new PublicLoginLimiter(3, 60_000, () => now);
  assert.equal(limiter.retryAfterS("1.1.1.1"), 0);
  limiter.fail("1.1.1.1"); now += 1_000; limiter.fail("1.1.1.1");
  assert.equal(limiter.retryAfterS("1.1.1.1"), 0, "two failures are still allowed");
  now += 1_000; limiter.fail("1.1.1.1");
  assert.equal(limiter.retryAfterS("1.1.1.1"), 58, "the oldest failure leaves the window in 58 seconds");
  assert.equal(limiter.retryAfterS("2.2.2.2"), 0, "another address is not affected");
  now += 57_000;
  assert.equal(limiter.retryAfterS("1.1.1.1"), 1);
  now += 1_000;
  assert.equal(limiter.retryAfterS("1.1.1.1"), 0, "the window passed");
  limiter.fail("3.3.3.3"); limiter.fail("3.3.3.3"); limiter.succeed("3.3.3.3"); limiter.fail("3.3.3.3");
  assert.equal(limiter.retryAfterS("3.3.3.3"), 0, "a success forgets the failures");
});

test("the table of failures does not grow without end under a flood of addresses", () => {
  const limiter = new PublicLoginLimiter(3, 60_000, () => 5);
  for (let index = 0; index < 10_050; index++) limiter.fail(`10.${index >> 8 & 255}.${index & 255}.1`);
  assert.equal(limiter.retryAfterS("10.0.0.1"), 0);
});

const outside = { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https" };
const remoteEnv = (dataDir: string, extra: Record<string, string> = {}) => ({ ARMOR_DATA_DIR: dataDir, ARMOR_LOCAL_NETWORKS: "10.99.0.0/24,127.0.0.0/8", ARMOR_TRUST_PROXY: "loopback", ARMOR_PUBLIC_ORIGIN: "https://armor.example.org", ARMOR_PUBLIC_LOGIN_ATTEMPTS: "3", ...extra });
const seed = (on: boolean) => { const dir = tempDir(); fs.writeFileSync(path.join(dir, "security-settings.json"), JSON.stringify({ settings: { "network.public_access": on } })); return dir; };

test("by default a request from outside the house is refused and one from inside is not", async () => {
  const running = await startServer(remoteEnv(tempDir()));
  try {
    const refused = await fetch(`${running.base}/api/v1/studio/session`, { headers: outside });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "public_access_off" });
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { headers: { "X-Forwarded-For": "10.99.0.5" } })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`)).status, 200, "this machine");
  } finally { await running.stop(); }
});

test("with the option on a request from outside needs TLS (the proxy says https); plain HTTP is refused", async () => {
  const running = await startServer(remoteEnv(seed(true)));
  try {
    const plain = await fetch(`${running.base}/api/v1/studio/session`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
    assert.equal(plain.status, 403);
    assert.deepEqual(await plain.json(), { error: "tls_required" });
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { headers: outside })).status, 200);
  } finally { await running.stop(); }
});

test("with the option on but no TLS anywhere the answer lists what is missing", async () => {
  const running = await startServer(remoteEnv(seed(true), { ARMOR_PUBLIC_ORIGIN: "http://armor.example.org", ARMOR_TRUST_PROXY: "false" }));
  try {
    const answer = await fetch(`${running.base}/api/v1/studio/session`);
    // no trusted proxy: the address seen is this machine's, which is local; the option does not matter for it
    assert.equal(answer.status, 200);
  } finally { await running.stop(); }
  const unsafe = await startServer(remoteEnv(seed(true), { ARMOR_PUBLIC_ORIGIN: "http://armor.example.org", ARMOR_LOCAL_NETWORKS: "10.99.0.0/24" }));
  try {
    const answer = await fetch(`${unsafe.base}/api/v1/studio/session`);
    assert.equal(answer.status, 403);
    const body = await answer.json() as { error: string; problems: string[] };
    assert.equal(body.error, "public_access_unsafe");
    assert.ok(body.problems.includes("tls_missing") && body.problems.includes("cookie_not_secure"));
  } finally { await unsafe.stop(); }
});

test("an address that fails to sign in three times from outside is closed with 429, another is not", async () => {
  const running = await startServer(remoteEnv(seed(true)));
  try {
    const attempt = (headers: Record<string, string>, password: string) => fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ username: SECRETS.ARMOR_STUDIO_USERNAME, password }) });
    for (let index = 0; index < 3; index++) assert.equal((await attempt(outside, "wrong-password-0")).status, 401);
    const locked = await attempt(outside, SECRETS.ARMOR_STUDIO_PASSWORD);
    assert.equal(locked.status, 429, "even the right password waits");
    assert.equal(((await locked.json()) as { code: string }).code, "public_login_locked");
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.equal((await attempt({ ...outside, "X-Forwarded-For": "203.0.113.10" }, SECRETS.ARMOR_STUDIO_PASSWORD)).status, 201, "another address signs in");
  } finally { await running.stop(); }
});
