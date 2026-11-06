import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { TRUSTED_TOTAL, TrustedDevices } from "../src/trusted_devices.js";
import { tempDir } from "./helpers.js";

const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");

test("removing a person forgets all their phones, keeps the others and survives a restart", () => {
  const file = path.join(tempDir(), "trusted.json");
  const store = new TrustedDevices(file);
  const a = store.register("ana", "Pixel", key()), b = store.register("ana", "Tablet", key()), c = store.register("luis", "Phone", key());
  assert.ok(typeof a === "object" && typeof b === "object" && typeof c === "object");
  store.removeUser("ana");
  assert.deepEqual(store.list("ana"), []);
  assert.equal(store.list("luis").length, 1);
  assert.equal(store.challenge((a as { id: string }).id), undefined, "a forgotten phone cannot be asked for a proof");
  assert.deepEqual(new TrustedDevices(file).list().map(device => device.userId), ["luis"]);
  // nobody to forget: nothing is written
  const before = fs.statSync(file).mtimeMs;
  store.removeUser("nobody");
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("the file is read with suspicion: bad ids, keys, names and a file that is not JSON give no trusted phone", () => {
  const dir = tempDir();
  const file = path.join(dir, "trusted.json");
  const good = { id: "a".repeat(24), userId: "u1", name: "x".repeat(200), publicKey: key(), createdAt: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify({ devices: [
    good,
    { ...good, id: "short" },
    { ...good, id: "B".repeat(24) },
    { ...good, publicKey: "AAAA" },
    { ...good, userId: 7 },
    { ...good, createdAt: undefined },
    "text", null,
  ] }));
  const loaded = new TrustedDevices(file).list();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.name.length, 60, "a long name is cut");
  fs.writeFileSync(file, "{broken");
  assert.deepEqual(new TrustedDevices(file).list(), []);
  fs.writeFileSync(file, JSON.stringify({ devices: "no" }));
  assert.deepEqual(new TrustedDevices(file).list(), []);
});

test("the server as a whole has a bound too, whoever the person is, and a name loses its control characters", () => {
  const store = new TrustedDevices(path.join(tempDir(), "trusted.json"));
  for (let index = 0; index < TRUSTED_TOTAL; index += 1) assert.ok(typeof store.register(`user-${index}`, "p", key()) === "object");
  assert.equal(store.register("one-more", "p", key()), "limit");
  const named = new TrustedDevices(path.join(tempDir(), "n.json")).register("u", "my\u0000\nphone", key());
  assert.ok(typeof named === "object" && named.name === "my  phone");
});

test("revoking a phone also drops a challenge that was waiting for it", () => {
  const store = new TrustedDevices(path.join(tempDir(), "trusted.json"));
  const device = store.register("u", "p", key());
  assert.ok(typeof device === "object");
  assert.ok(store.challenge(device.id));
  assert.equal(store.remove(device.id), true);
  assert.equal(store.remove(device.id), false);
  assert.equal(store.challenge(device.id), undefined);
});
