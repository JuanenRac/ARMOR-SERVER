import assert from "node:assert/strict";
import test from "node:test";
import { ingestCaller, nodeTokenFor } from "../src/http/node_token.js";

const request = (token: string) => ({ header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) });
const SHARED = "s".repeat(32);

test("a node's own token is good for that node only", () => {
  const mine = nodeTokenFor(SHARED, "radar-1");
  assert.equal(mine.length, 64);
  assert.notEqual(mine, nodeTokenFor(SHARED, "radar-2"));
  assert.equal(ingestCaller(request(mine), SHARED, false, "radar-1"), "node");
  assert.equal(ingestCaller(request(mine), SHARED, false, "radar-2"), null);
  assert.equal(ingestCaller(request(mine), SHARED, true, "radar-1"), "node");
});

test("the shared token is accepted until the strict mode is on, and a made-up node id is refused", () => {
  assert.equal(ingestCaller(request(SHARED), SHARED, false, "radar-1"), "shared");
  assert.equal(ingestCaller(request(SHARED), SHARED, true, "radar-1"), null);
  assert.equal(ingestCaller(request(nodeTokenFor(SHARED, "../x")), SHARED, true, "../x"), null);
  assert.equal(ingestCaller(request(SHARED), SHARED, false, undefined), "shared");
  assert.equal(ingestCaller(request("nope"), SHARED, false, "radar-1"), null);
});
