// The check of the coverage floor (tools/coverage_check.mjs): how it reads the floor, the totals of the report of Node, and what falls under it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script, not a typed module
import { belowFloor, parseTotals, readFloor } from "../tools/coverage_check.mjs";

test("the floor of the repository is three numbers from 0 to 100", () => {
  const floor = readFloor(fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "coverage_threshold.json"), "utf8"));
  assert.deepEqual(Object.keys(floor).sort(), ["branches", "functions", "lines"]);
  for (const value of Object.values(floor) as number[]) assert.ok(value > 0 && value <= 100);
});

test("a floor with a missing, negative, too large or non-numeric measure is refused", () => {
  assert.throws(() => readFloor('{"lines": 90, "branches": 80}'), /functions must be a number/);
  assert.throws(() => readFloor('{"lines": -1, "branches": 80, "functions": 80}'), /lines must be a number/);
  assert.throws(() => readFloor('{"lines": 101, "branches": 80, "functions": 80}'), /lines must be a number/);
  assert.throws(() => readFloor('{"lines": "90", "branches": 80, "functions": 80}'), /lines must be a number/);
  assert.throws(() => readFloor("not json"));
  assert.deepEqual(readFloor('{"lines": 90, "branches": 80.5, "functions": 70}'), { lines: 90, branches: 80.5, functions: 70 });
});

test("the totals are read from the line 'all files' of the report, whatever the spacing", () => {
  const report = "# src |  |  | \n#  app.ts | 74.26 | 82.00 | 35.71 | 1-5\n# all files                           |  93.31 |    90.93 |   93.82 | \n# end of coverage report";
  assert.deepEqual(parseTotals(report), { lines: 93.31, branches: 90.93, functions: 93.82 });
  assert.equal(parseTotals("no table here"), null);
});

test("a measure under its floor is named, and one at the floor passes", () => {
  const floor = { lines: 92, branches: 89, functions: 92 };
  assert.deepEqual(belowFloor({ lines: 93, branches: 90, functions: 93 }, floor), []);
  assert.deepEqual(belowFloor({ lines: 92, branches: 89, functions: 92 }, floor), []);
  assert.deepEqual(belowFloor({ lines: 91.9, branches: 90, functions: 93 }, floor), ["lines 91.9% is under the floor of 92%"]);
  assert.equal(belowFloor({ lines: 10, branches: 10, functions: 10 }, floor).length, 3);
});
