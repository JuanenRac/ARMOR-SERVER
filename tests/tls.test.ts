import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { createArmorApp } from "../src/app.js";
import { ConfigError, readConfig } from "../src/config.js";
import { SECRETS, tempDir } from "./helpers.js";

/** A real, throwaway self-signed certificate - the exact command README.md's
 * own "TLS / HTTPS" section documents for local testing, not a fixture
 * committed to the repo (a 1-day validity is plenty for one test run). */
function generateSelfSignedCert(dir: string): { certPath: string; keyPath: string } {
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  // Deliberately drops any inherited OPENSSL_CONF: a developer machine
  // can have one pointing at a config file belonging to a completely
  // different OpenSSL install (found for real on Windows with a stray
  // Laragon-set OPENSSL_CONF) - this call needs no config file at all for
  // a self-signed cert, so it should never depend on whatever happens to
  // be set globally on the machine running the test.
  const { OPENSSL_CONF: _unused, ...env } = process.env;
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
  ], { env });
  return { certPath, keyPath };
}

test("TLS is off by default, and TLS_CERT_PATH/TLS_KEY_PATH must both be set together", () => {
  const dir = tempDir();
  const { certPath, keyPath } = generateSelfSignedCert(dir);
  assert.equal(readConfig({ ...SECRETS }).tls, null);
  // Exactly one set - a typo'd variable name, not an intentional choice -
  // is a ConfigError, not a silent fallback to plain HTTP (see config.ts's
  // own comment on why this is stricter than HYDRA-UMC-SERVER's version).
  assert.throws(() => readConfig({ ...SECRETS, TLS_CERT_PATH: certPath }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, TLS_KEY_PATH: keyPath }), ConfigError);
  assert.deepEqual(readConfig({ ...SECRETS, TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath }).tls, { certPath, keyPath });
});

test("a TLS path that does not exist is refused at configuration time, not silently ignored", () => {
  assert.throws(
    () => readConfig({ ...SECRETS, TLS_CERT_PATH: "/does/not/exist/cert.pem", TLS_KEY_PATH: "/does/not/exist/key.pem" }),
    ConfigError,
  );
});

test("with TLS configured, the shared listener really answers over HTTPS", async () => {
  const dir = tempDir();
  const { certPath, keyPath } = generateSelfSignedCert(dir);
  const config = readConfig({ ...SECRETS, ARMOR_DATA_DIR: tempDir(), TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath });
  const app = createArmorApp(config, "test");
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      // A self-signed cert has no real chain of trust - the point of this
      // test is that the TLS handshake itself succeeds at all (a plain
      // HTTP client against this same port would fail immediately with a
      // protocol error instead).
      const request = https.get(
        { hostname: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false },
        response => {
          let data = "";
          response.on("data", chunk => { data += chunk; });
          response.on("end", () => resolve(data));
        },
      );
      request.on("error", reject);
    });
    assert.deepEqual(JSON.parse(body), { ok: true, service: "armor-server" });
  } finally {
    await app.close();
  }
});
