import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, parseOrigin, readConfig } from "../src/config.js";
import { SECRETS } from "./helpers.js";

test("a complete environment produces a typed configuration with safe defaults", () => {
  const config = readConfig({ ...SECRETS });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8080);
  assert.equal(config.cookieSecure, false);
  assert.equal(config.maxMjpegRelays, 8);
  assert.ok(config.studioOrigins.includes("http://127.0.0.1:5178"));
});

test("weak or missing secrets stop the server from starting", () => {
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_INGEST_TOKEN: "short" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_CONTROL_TOKEN: "" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_STUDIO_PASSWORD: "short", ARMOR_HOST: "0.0.0.0" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_STUDIO_USERNAME: "" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_CAMERA_CONFIG_KEY: "tooshort" }), ConfigError);
});

test("numbers are range-checked instead of silently becoming NaN", () => {
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_PORT: "abc" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_PORT: "70000" }), ConfigError);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_MAX_MJPEG_RELAYS: "0" }), ConfigError);
  assert.equal(readConfig({ ...SECRETS, ARMOR_PORT: "18080" }).port, 18080);
});

test("Studio origins must be bare http(s) origins", () => {
  assert.equal(parseOrigin("http://192.168.0.5:18081"), "http://192.168.0.5:18081");
  for (const bad of ["ftp://x", "http://u:p@x", "http://x/path", "http://x?q", "nope"]) assert.equal(parseOrigin(bad), null);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_STUDIO_ORIGIN: "http://x/path" }), ConfigError);
  assert.ok(readConfig({ ...SECRETS, ARMOR_STUDIO_ORIGIN: "http://10.0.0.5:18081" }).studioOrigins.includes("http://10.0.0.5:18081"));
});

test("the camera key falls back to the control token only when it is not configured", () => {
  const { ARMOR_CAMERA_CONFIG_KEY: _key, ...withoutKey } = SECRETS;
  const fallback = readConfig(withoutKey);
  assert.equal(fallback.cameraKeyIsFallback, true);
  assert.equal(fallback.cameraConfigKey, SECRETS.ARMOR_CONTROL_TOKEN);
  assert.equal(readConfig({ ...SECRETS }).cameraKeyIsFallback, false);
});

test("the discovery CIDR must be a /24", () => {
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_CAMERA_DISCOVERY_CIDR: "10.0.0.0/16" }), ConfigError);
  assert.equal(readConfig({ ...SECRETS, ARMOR_CAMERA_DISCOVERY_CIDR: "192.168.0.0/24" }).discoveryCidr, "192.168.0.0/24");
});

test("a short Studio password is only a warning on a loopback-only server", () => {
  const local = readConfig({ ...SECRETS, ARMOR_STUDIO_PASSWORD: "short-pw9" });
  assert.equal(local.warnings.length, 1);
  assert.equal(readConfig({ ...SECRETS }).warnings.length, 0);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_STUDIO_PASSWORD: "short-pw9", ARMOR_HOST: "192.168.0.10" }), ConfigError);
});
