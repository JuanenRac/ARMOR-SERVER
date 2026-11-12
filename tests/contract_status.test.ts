// The version of the shared contracts each node says it was checked against, beside the server's: the comparison, the answer of the route and who may read it.
import assert from "node:assert/strict";
import test from "node:test";
import { contractStatus, relation, versionParts } from "../src/contract_status.js";
import { CONTRACT_VERSION } from "../src/contract_version.js";
import type { NodeHealthMessage } from "../src/node_health.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

test("versions of three or four parts are compared part by part, a missing fourth part being zero", () => {
  assert.deepEqual(versionParts("0.8.0.7"), [0, 8, 0, 7]);
  assert.deepEqual(versionParts("0.8.1"), [0, 8, 1, 0]);
  for (const bad of ["", "0.8", "0.8.0.7.1", "v0.8.0", "0.8.x", 8, null, undefined, "0.8.0 "]) assert.equal(versionParts(bad), undefined, String(bad));
  assert.equal(relation("0.8.0.7", "0.8.0.7"), "current");
  assert.equal(relation("0.8.0", "0.8.0.0"), "current");
  assert.equal(relation("0.8.0.6", "0.8.0.7"), "older");
  assert.equal(relation("0.7.9.9", "0.8.0.0"), "older");
  assert.equal(relation("0.8.1.0", "0.8.0.9"), "newer");
  assert.equal(relation("0.10.0", "0.9.9"), "newer", "numbers, not text: 10 is more than 9");
  assert.equal(relation(undefined, "0.8.0.7"), "unknown");
  assert.equal(relation("soon", "0.8.0.7"), "unknown");
  assert.equal(relation("0.8.0.7", "not a version"), "unknown");
});

test("the status lists the nodes in order of name, with the totals of each relation, and leaves a value that is not a version out", () => {
  const status = contractStatus("0.8.0.7", [
    { node_id: "solar-1", family: "solar", report: { contract: "0.8.0.5" } },
    { node_id: "alarm-1", family: "alarm", report: { contract: "0.8.0.7" } },
    { node_id: "radar-1", family: "radar", report: {} },
    { node_id: "hmi-1", family: "hmi", report: { contract: "0.9.0" } },
    { node_id: "hmi-2", family: "hmi", report: { contract: "<script>" } },
  ]);
  assert.equal(status.server, "0.8.0.7");
  assert.deepEqual(status.nodes.map(node => `${node.node_id}:${node.status}:${node.contract}`), ["alarm-1:current:0.8.0.7", "hmi-1:newer:0.9.0", "hmi-2:unknown:null", "radar-1:unknown:null", "solar-1:older:0.8.0.5"]);
  assert.deepEqual(status.totals, { current: 1, older: 1, newer: 1, unknown: 2 });
  assert.deepEqual(contractStatus("0.8.0.7", []), { server: "0.8.0.7", nodes: [], totals: { current: 0, older: 0, newer: 0, unknown: 0 } });
});

test("GET /api/v1/contract gives the server's version and the state of each node that reported, to an operator and a signed-in person, and to nobody else", async () => {
  const running = await startServer();
  try {
    const { context } = running.app;
    const base = { kind: "node_health", timestamp_ms: 5000, firmware: "0.8.0", uptime_s: 100, reset_reason: "power_on", heap_free: 142_000, heap_min: 98_000, link: "ethernet", link_up: true, broker_reconnects: 0 } as const;
    context.nodeHealth.ingest({ ...base, node_id: "radar-1", family: "radar", contract: CONTRACT_VERSION } as NodeHealthMessage);
    context.nodeHealth.ingest({ ...base, node_id: "solar-1", family: "solar", contract: "0.1.0" } as NodeHealthMessage);
    context.nodeHealth.ingest({ ...base, node_id: "alarm-1", family: "alarm" } as NodeHealthMessage);
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    const asked = await fetch(`${running.base}/api/v1/contract`, { headers: operator });
    assert.equal(asked.status, 200);
    const body = await asked.json() as { server: string; nodes: Array<{ node_id: string; status: string; contract: string | null; family: string }>; totals: Record<string, number> };
    assert.equal(body.server, CONTRACT_VERSION);
    assert.deepEqual(body.nodes.map(node => `${node.node_id}:${node.family}:${node.status}`), ["alarm-1:alarm:unknown", "radar-1:radar:current", "solar-1:solar:older"]);
    assert.deepEqual(body.totals, { current: 1, older: 1, newer: 0, unknown: 1 });
    assert.equal(JSON.stringify(body).includes(SECRETS.ARMOR_OPERATOR_TOKEN), false);
    const cookie = await studioCookie(running.base);
    assert.equal((await fetch(`${running.base}/api/v1/contract`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/contract`)).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/contract`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  } finally { await running.stop(); }
});
