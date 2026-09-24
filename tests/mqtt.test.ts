import assert from "node:assert/strict";
import test from "node:test";
import { topicKind } from "../src/mqtt.js";
test("accepts only published field observation topics", () => { assert.equal(topicKind("armor/node/north-1/telemetry"), "telemetry"); assert.equal(topicKind("armor/node/north-1/command"), undefined); });
