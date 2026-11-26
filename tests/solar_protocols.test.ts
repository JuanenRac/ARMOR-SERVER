// The catalogue of the equipment protocols: the server's table is ARMOR-COMMON's, and every inverter family points at a variant a node knows.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { INVERTER_FAMILIES } from "../src/solar_registry.js";
import { SOLAR_PROTOCOLS } from "../src/solar_protocols.js";

const shared = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "src", "armor_common", "solar_protocols.json");

test("the server's table of protocols is the shared table", { skip: fs.existsSync(shared) ? false : "ARMOR-COMMON has no catalogue next to this repository" }, () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SOLAR_PROTOCOLS)), JSON.parse(fs.readFileSync(shared, "utf8")));
});

test("every protocol has a unique id and every inverter family a variant of the catalogue", () => {
  const ids = SOLAR_PROTOCOLS.protocols.map(protocol => protocol.id);
  assert.equal(new Set(ids).size, ids.length);
  const variants = new Set<string>(SOLAR_PROTOCOLS.protocols.filter(protocol => protocol.message === "inverter").map(protocol => protocol.dialect));
  for (const [model, family] of Object.entries(INVERTER_FAMILIES)) assert.ok(family.dialect === "auto" || variants.has(family.dialect), model);
});
