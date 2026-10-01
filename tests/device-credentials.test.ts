import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialsInvalid, DeviceCredentials } from "../src/device_credentials.js";

const make = (secret = "secret-one") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-logins-"));
  const file = path.join(dir, "network-logins.json");
  return { file, store: new DeviceCredentials({ file, secret }) };
};

test("a login is kept encrypted and only its user is shown", () => {
  const { file, store } = make();
  store.set("aa:bb:cc:dd:ee:ff", { user: "admin", password: "hunter2-pass" });
  assert.deepEqual(store.summary("aa:bb:cc:dd:ee:ff"), { user: "admin" });
  assert.deepEqual(store.get("aa:bb:cc:dd:ee:ff"), { user: "admin", password: "hunter2-pass" });
  assert.equal(fs.readFileSync(file, "utf8").includes("hunter2-pass"), false);
});

test("a login survives a restart and is unreadable with another secret", () => {
  const { file, store } = make();
  store.set("dev1", { user: "root", password: "x" });
  assert.equal(new DeviceCredentials({ file, secret: "secret-one" }).get("dev1")?.user, "root");
  assert.equal(new DeviceCredentials({ file, secret: "other" }).summary("dev1"), undefined);
});

test("invalid logins are refused and a login can be forgotten", () => {
  const { store } = make();
  assert.throws(() => store.set("dev1", { user: "", password: "x" }), CredentialsInvalid);
  assert.throws(() => store.set("dev1", { user: "a\nb", password: "x" }), CredentialsInvalid);
  assert.throws(() => store.set("Bad Id!", { user: "a", password: "x" }), CredentialsInvalid);
  store.set("dev1", { user: "a", password: "" });
  assert.equal(store.remove("dev1"), true);
  assert.equal(store.remove("dev1"), false);
});
