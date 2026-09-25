import assert from "node:assert/strict";
import test from "node:test";
import { bodyMatchesTopic, topicKind, topicNode } from "../src/mqtt.js";

test("accepts only published field observation topics", () => {
  assert.equal(topicKind("armor/node/north-1/telemetry"), "telemetry");
  assert.equal(topicKind("armor/node/north-1/command"), undefined);
  assert.equal(topicKind("armor/node/north-1/telemetry/extra"), undefined);
  assert.equal(topicKind("armor/server/alert"), undefined);
});

test("a node can only speak for itself: the body must name the node of the topic", () => {
  assert.equal(topicNode("armor/node/north-1/telemetry"), "north-1");
  assert.equal(topicNode("armor/node//telemetry"), undefined);
  assert.equal(bodyMatchesTopic("armor/node/north-1/telemetry", { node_id: "north-1" }), true);
  assert.equal(bodyMatchesTopic("armor/node/north-1/telemetry", { node_id: "south-2" }), false, "impersonation of a neighbour");
  assert.equal(bodyMatchesTopic("armor/other/north-1/telemetry", { node_id: "north-1" }), false);
});
