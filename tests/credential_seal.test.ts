import assert from "node:assert/strict";
import test from "node:test";
import { openSealed, sealFor } from "../src/http/credential_seal.js";
import { nodeTokenFor } from "../src/http/node_token.js";

test("a sealed login opens with the same token and only with it", () => {
  const token = nodeTokenFor("i".repeat(32), "net-1");
  const sealed = sealFor(token, JSON.stringify({ user: "admin", password: "p4ss wörd" }));
  assert.equal(openSealed(token, sealed), JSON.stringify({ user: "admin", password: "p4ss wörd" }));
  assert.equal(openSealed(nodeTokenFor("i".repeat(32), "net-2"), sealed), null);
  assert.ok(!Buffer.from(sealed, "base64").toString("latin1").includes("p4ss"));
});

test("a changed seal is refused", () => {
  const token = "t".repeat(64);
  const raw = Buffer.from(sealFor(token, "secret"), "base64");
  raw[17] ^= 1;
  assert.equal(openSealed(token, raw.toString("base64")), null);
  assert.equal(openSealed(token, "AAAA"), null);
});

test("the format is fixed so the node (Python) can open it", () => {
  const sealed = sealFor("k".repeat(64), "hello", Buffer.alloc(16, 7));
  assert.equal(sealed, "BwcHBwcHBwcHBwcHBwcHB3DjzPUrsd3Gaw4Uk/BJhSrk1lLZbEo7RPBc5R3QOGEQdtGjYbg=");   // the same bytes are checked by ARMOR-NETWORK's tests/test_seal.py
});
