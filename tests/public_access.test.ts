import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { createArmorApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { PublicLoginLimiter, decidePublicRequest, publicAccessProblems } from "../src/public_access.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

const good = { ownTls: true, controlTokenLength: 32, studioPasswordLength: 12, cookieSecure: true };

test("the facts that stop the server taking requests from the Internet are named one by one", () => {
  assert.deepEqual(publicAccessProblems(good), []);
  assert.deepEqual(publicAccessProblems({ ...good, ownTls: false }), ["tls_missing"]);
  assert.deepEqual(publicAccessProblems({ ...good, controlTokenLength: 31 }), ["control_token_short"]);
  assert.deepEqual(publicAccessProblems({ ...good, studioPasswordLength: 11 }), ["password_short"]);
  assert.deepEqual(publicAccessProblems({ ...good, cookieSecure: false }), ["cookie_not_secure"]);
  assert.deepEqual(publicAccessProblems({ ownTls: false, controlTokenLength: 0, studioPasswordLength: 0, cookieSecure: false }), ["tls_missing", "control_token_short", "password_short", "cookie_not_secure"]);
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

// A request that reaches the port itself is "from outside" when the address of the connection is not in ARMOR_LOCAL_NETWORKS: 127.0.0.1 is made to count as outside here.
const outsideEnv = (dataDir: string, extra: Record<string, string> = {}) => ({ ARMOR_HOST: "0.0.0.0", ARMOR_DATA_DIR: dataDir, ARMOR_LOCAL_NETWORKS: "10.99.0.0/24", ARMOR_PUBLIC_LOGIN_ATTEMPTS: "3", ...extra });
const seed = (on: boolean) => { const dir = tempDir(); fs.writeFileSync(path.join(dir, "security-settings.json"), JSON.stringify({ settings: { "network.public_access": on } })); return dir; };

test("by default a request that reaches the port from outside the house is refused and one from inside is not", async () => {
  const outside = await startServer(outsideEnv(tempDir()));
  try {
    const refused = await fetch(`${outside.base}/api/v1/studio/session`);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "public_access_off" });
  } finally { await outside.stop(); }
  const inside = await startServer(outsideEnv(tempDir(), { ARMOR_LOCAL_NETWORKS: "127.0.0.0/8" }));
  try { assert.equal((await fetch(`${inside.base}/api/v1/studio/session`)).status, 200); } finally { await inside.stop(); }
});

test("a server that listens on the loopback only gates nothing: there is no port to open", async () => {
  const running = await startServer(outsideEnv(tempDir(), { ARMOR_HOST: "127.0.0.1" }));
  try { assert.equal((await fetch(`${running.base}/api/v1/studio/session`)).status, 200); } finally { await running.stop(); }
});

test("a request through the reverse proxy of ARMOR_TRUST_PROXY, the documented door, is not touched by the option", async () => {
  const running = await startServer(outsideEnv(tempDir(), { ARMOR_TRUST_PROXY: "loopback" }));
  try {
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { headers: { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https" } })).status, 200);
  } finally { await running.stop(); }
});

test("with the option on but no TLS of its own the answer lists what is missing", async () => {
  const running = await startServer(outsideEnv(seed(true)));
  try {
    const answer = await fetch(`${running.base}/api/v1/studio/session`);
    assert.equal(answer.status, 403);
    const body = await answer.json() as { error: string; problems: string[] };
    assert.equal(body.error, "public_access_unsafe");
    assert.deepEqual(body.problems, ["tls_missing", "cookie_not_secure"]);
  } finally { await running.stop(); }
});

function selfSigned(): { certPath: string; keyPath: string } {
  const dir = tempDir(), certPath = path.join(dir, "cert.pem"), keyPath = path.join(dir, "key.pem");
  const { OPENSSL_CONF: _unused, ...env } = process.env;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { env });
  return { certPath, keyPath };
}

test("over TLS with the option on and strong secrets a request from outside is taken, and an address that fails to sign in three times is closed with 429", async () => {
  const { certPath, keyPath } = selfSigned();
  const config = readConfig({ ...SECRETS, ...outsideEnv(seed(true)), TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath });
  const app = createArmorApp(config, "test");
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const call = (method: string, body?: unknown) => new Promise<{ status: number; text: string; retryAfter: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request({ hostname: "127.0.0.1", port, path: "/api/v1/studio/session", method, ca: fs.readFileSync(certPath), servername: "localhost", headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, response => {
      let data = "";
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: data, retryAfter: String(response.headers["retry-after"] ?? "") }));
    });
    request.on("error", reject);
    request.end(payload);
  });
  try {
    assert.equal((await call("GET")).status, 200);
    for (let index = 0; index < 3; index++) assert.equal((await call("POST", { username: SECRETS.ARMOR_STUDIO_USERNAME, password: "wrong-password-0" })).status, 401);
    const locked = await call("POST", { username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD });
    assert.equal(locked.status, 429, "even the right password waits");
    assert.equal((JSON.parse(locked.text) as { code: string }).code, "public_login_locked");
    assert.ok(Number(locked.retryAfter) > 0);
  } finally { await app.close(); }
});
