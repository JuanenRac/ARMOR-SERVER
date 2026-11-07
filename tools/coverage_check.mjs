// Runs the test suite with the coverage of Node and fails when a measure falls under the floor in docs/coverage_threshold.json
// (lines, branches, functions: a number each, just under what the tests reach; raising a floor is a change of that file).
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const readFloor = (text) => {
  const data = JSON.parse(text);
  const floor = {};
  for (const key of ["lines", "branches", "functions"]) {
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`docs/coverage_threshold.json: ${key} must be a number from 0 to 100`);
    floor[key] = value;
  }
  return floor;
};
/** The line "all files" of the report of Node: the three measures, or null when the report has none. */
export const parseTotals = (report) => {
  const match = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i.exec(report);
  return match ? { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) } : null;
};
export const belowFloor = (totals, floor) => Object.keys(floor).filter(key => totals[key] < floor[key]).map(key => `${key} ${totals[key]}% is under the floor of ${floor[key]}%`);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const floor = readFloor(fs.readFileSync(path.join(root, "docs", "coverage_threshold.json"), "utf8"));
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "--experimental-test-coverage", ...fs.readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.ts")).map(name => path.join("tests", name))],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const totals = parseTotals(report);
  if (run.status !== 0) { process.stderr.write(report.slice(-4000)); console.error("COVERAGE=FAIL the tests failed"); process.exit(1); }
  if (!totals) { console.error("COVERAGE=FAIL the report of Node has no totals"); process.exit(1); }
  const under = belowFloor(totals, floor);
  console.log(`COVERAGE lines=${totals.lines}% branches=${totals.branches}% functions=${totals.functions}% floor=${floor.lines}/${floor.branches}/${floor.functions}`);
  if (under.length) { console.error(`COVERAGE=FAIL ${under.join("; ")}`); process.exit(1); }
  console.log("COVERAGE=PASS");
}
