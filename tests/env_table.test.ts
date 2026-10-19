// docs/ENVIRONMENT.md is generated from the code and the example file; a setting added to either without regenerating it fails here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script, not a typed module
import { render } from "../tools/env_table.mjs";

test("docs/ENVIRONMENT.md is current", () => {
  const file = path.resolve(import.meta.dirname, "..", "docs", "ENVIRONMENT.md");
  assert.equal(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), render());
});
