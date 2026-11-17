import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ingestCaller, legacyNodeTokenFor, NodeTokens } from "../src/http/node_token.js";
import { tempDir } from "./helpers.js";

const request = (token: string) => ({ header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) });
const SHARED = "s".repeat(32);
const tokens = new NodeTokens(path.join(tempDir(), "node-token.key"));

test("a node's own token is good for that node only", () => {
  const mine = tokens.tokenFor("radar-1");
  assert.equal(mine.length, 64);
  assert.notEqual(mine, tokens.tokenFor("radar-2"));
  assert.equal(ingestCaller(request(mine), SHARED, false, "radar-1", tokens), "node");
  assert.equal(ingestCaller(request(mine), SHARED, false, "radar-2", tokens), null);
  assert.equal(ingestCaller(request(mine), SHARED, true, "radar-1", tokens), "node");
});

test("the shared token is accepted until the strict mode is on, and a made-up node id is refused", () => {
  assert.equal(ingestCaller(request(SHARED), SHARED, false, "radar-1", tokens), "shared");
  assert.equal(ingestCaller(request(SHARED), SHARED, true, "radar-1", tokens), null);
  assert.equal(ingestCaller(request(legacyNodeTokenFor(SHARED, "../x")), SHARED, true, "../x", tokens), null);
  assert.equal(ingestCaller(request(SHARED), SHARED, false, undefined, tokens), "shared");
  assert.equal(ingestCaller(request("nope"), SHARED, false, "radar-1", tokens), null);
});

test("the token of a node comes from a key of the server that no board holds, and the one an older version derived from the shared token is only the shared token", () => {
  const dir = tempDir(), file = path.join(dir, "node-token.key");
  const own = new NodeTokens(file);
  const mine = own.tokenFor("radar-1");
  assert.notEqual(mine, legacyNodeTokenFor(SHARED, "radar-1"), "it cannot be worked out from the shared token");
  assert.match(fs.readFileSync(file, "utf8"), /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new NodeTokens(file).tokenFor("radar-1"), mine, "the key is kept: the token is the same after a restart");
  assert.notEqual(new NodeTokens(path.join(tempDir(), "other.key")).tokenFor("radar-1"), mine, "another installation, another token");
  // the old token is taken only while the strict mode is off, and as the shared token is: it is not a node
  const old = legacyNodeTokenFor(SHARED, "radar-1");
  assert.equal(ingestCaller(request(old), SHARED, false, "radar-1", own), "shared");
  assert.equal(ingestCaller(request(old), SHARED, true, "radar-1", own), null);
  assert.equal(ingestCaller(request(old), SHARED, false, "radar-2", own), null, "and for its own node only");
});
