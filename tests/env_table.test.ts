// docs/ENVIRONMENT.md is generated from the code and the example file; a setting added to either without regenerating it fails here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script, not a typed module
import { escapeCell, exampleCell, render } from "../tools/env_table.mjs";

test("a backslash in a table cell is doubled before a pipe is escaped", () => {
  assert.equal(escapeCell("a\\|b"), "a\\\\\\|b");
  assert.equal(escapeCell("x | y"), "x \\| y");
});

test("docs/ENVIRONMENT.md is current", () => {
  const file = path.resolve(import.meta.dirname, "..", "docs", "ENVIRONMENT.md");
  assert.equal(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), render());
});

test("an example keeps its backslashes and refuses what a table cell cannot hold", () => {
  assert.equal(exampleCell("C:\\Tools"), "`C:\\Tools`");
  assert.equal(exampleCell(""), "");
  assert.throws(() => exampleCell("a|b"));
});
