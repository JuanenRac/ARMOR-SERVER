import assert from "node:assert/strict";
import test from "node:test";
import { parseTelemetry } from "../src/contracts.js";
import { ArmorStore } from "../src/store.js";
test("rejects an unbounded radar target list", () => assert.throws(() => parseTelemetry({ node_id: "north-1", timestamp_ms: 1, lux: 1, targets: new Array(16).fill({}) })));
test("does not let stale telemetry replace newer state", () => { const store = new ArmorStore(); store.telemetry(parseTelemetry({ node_id: "north-1", timestamp_ms: 2, lux: 2, targets: [] })); store.telemetry(parseTelemetry({ node_id: "north-1", timestamp_ms: 1, lux: 1, targets: [] })); assert.equal(store.snapshot().nodes["north-1"].lux, 2); });
