import assert from "node:assert/strict";
import test from "node:test";
import { cameraGeometry, coveringNodes, nodeGeometry, trackPoints } from "../src/ai_cover.js";

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

const placed = {
  dimensions: { width: 60, depth: 40, height: 3 },
  cameras: [{ id: "cam-front", x: 10, y: 50, heading: 90, fov: 100, range: 12 }, { id: "cam-nohead", x: 10, y: 50 }],
  sensors: [{ id: "r1", x: 12.5, y: 25, heading: 180, node: "radar-front" }, { id: "r2", x: 50, y: 50, heading: 0, node: "radar-back", mirror: true }, { id: "r3", x: 5, y: 5, heading: 0, node: "radar-two" }, { id: "r4", x: 6, y: 6, heading: 0, node: "radar-two" }],
};

test("a camera and a radar are placed on the plan in millimetres, with the way they face", () => {
  assert.deepEqual(cameraGeometry(placed, "cam-front"), { pose: { x_mm: 6000, y_mm: 20000, yaw_deg: 90 }, fov_deg: 100, range_mm: 12000 });
  assert.deepEqual(nodeGeometry(placed, "radar-front"), { pose: { x_mm: 7500, y_mm: 10000, yaw_deg: 180 }, mirror: false });
  assert.equal(nodeGeometry(placed, "radar-back")?.mirror, true);
});

test("what the design does not say is left out, never guessed", () => {
  assert.deepEqual(cameraGeometry(placed, "cam-nohead"), {}, "no heading: no pose");
  assert.deepEqual(cameraGeometry(null, "cam-front"), {});
  assert.deepEqual(cameraGeometry(placed, "nope"), {});
  assert.deepEqual(cameraGeometry({ ...placed, dimensions: { width: 0, depth: 40 } }, "cam-front"), {});
  assert.equal(nodeGeometry(placed, "radar-two"), undefined, "two radars for one node: a track could belong to either");
  assert.equal(nodeGeometry(placed, "no-node"), undefined);
  assert.equal(nodeGeometry(null, "radar-front"), undefined);
  assert.deepEqual(cameraGeometry({ ...placed, cameras: [{ id: "c", x: 1, y: 1, heading: 0, fov: 5, range: -3 }] }, "c"), { pose: { x_mm: 600, y_mm: 400, yaw_deg: 0 } }, "a field of view or reach that is not sensible is dropped");
});

test("the tracks of a radar are the counted ones, mirrored when its sideways axis is the other way, and at most 16", () => {
  const targets = [{ x_mm: 500, y_mm: 2000, counted: true }, { x_mm: 9, y_mm: 9, counted: false }, { x_mm: Number.NaN, y_mm: 1, counted: true }];
  assert.deepEqual(trackPoints(targets, false), [{ x_mm: 500, y_mm: 2000 }]);
  assert.deepEqual(trackPoints(targets, true), [{ x_mm: -500, y_mm: 2000 }]);
  assert.equal(trackPoints(Array.from({ length: 40 }, (_, i) => ({ x_mm: i, y_mm: i })), false).length, 16);
});
