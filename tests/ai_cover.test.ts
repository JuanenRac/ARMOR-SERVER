import assert from "node:assert/strict";
import test from "node:test";
import { coveringNodes } from "../src/ai_cover.js";

const site = {
  dimensions: { width: 60, depth: 40, height: 3 },
  cameras: [{ id: "cam-front", x: 10, y: 50 }, { id: "cam-far", x: 90, y: 50, range: 5 }],
  sensors: [{ id: "r1", x: 12, y: 50, node: "radar-front" }, { id: "r2", x: 88, y: 50, node: "radar-back" }, { id: "r3", x: 50, y: 50, node: "radar-mid" }, { id: "free", x: 11, y: 50 }],
};

test("a camera is weighed against the radars that stand near it, and no others", () => {
  assert.deepEqual(coveringNodes(site, "cam-front"), ["radar-front"]);
  assert.deepEqual(coveringNodes(site, "cam-far"), ["radar-back"]);
});

test("when the design cannot say, the answer is undefined (every node counts)", () => {
  assert.equal(coveringNodes(null, "cam-front"), undefined);
  assert.equal(coveringNodes(site, "no-such-camera"), undefined);
  assert.equal(coveringNodes({ ...site, sensors: [{ id: "free", x: 11, y: 50 }] }, "cam-front"), undefined);
  assert.equal(coveringNodes({ cameras: site.cameras, sensors: site.sensors }, "cam-front"), undefined);
});
