// The TypeScript boundary must accept and reject exactly what the published
// contracts (ARMOR-COMMON/conformance) accept and reject.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseHealth, parseInfo, parseTelemetry } from "../src/contracts.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
const available = fs.existsSync(directory);

type Vector = { name: string; valid: boolean; payload: unknown };
const load = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;

for (const [kind, parse] of [["telemetry", parseTelemetry], ["health", parseHealth], ["info", parseInfo]] as const) {
  test(`${kind} parsing agrees with every shared conformance vector`, { skip: available ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
    for (const vector of load(kind)) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `should reject: ${vector.name}`);
    }
  });
}

const generated = path.resolve(directory, "..", "generated", "armor-contracts.ts");
test("the limits in src/contracts.ts match the generated contract constants", { skip: fs.existsSync(generated) ? false : "ARMOR-COMMON generated types are not available" }, async () => {
  const text = fs.readFileSync(generated, "utf8");
  const { MAX_TARGETS, MAX_LUX } = await import("../src/contracts.js");
  assert.equal(Number(/MAX_TARGETS = (\d+)/.exec(text)?.[1]), MAX_TARGETS);
  assert.equal(Number(/MAX_LUX = (\d+)/.exec(text)?.[1]), MAX_LUX);
});

// The contract file carries ARMOR-COMMON's release in its name; the newest one is the current contract.
const openapiDirectory = path.resolve(directory, "..", "openapi");
const openapiFiles = fs.existsSync(openapiDirectory) ? fs.readdirSync(openapiDirectory).filter(name => /^armor-server-\d+\.\d+\.\d+\.yaml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
const openapi = path.join(openapiDirectory, openapiFiles[openapiFiles.length - 1] ?? "armor-server.yaml");
test("every route the server registers is described in the OpenAPI contract", { skip: fs.existsSync(openapi) ? false : "ARMOR-COMMON OpenAPI is not available" }, () => {
  const described = fs.readFileSync(openapi, "utf8");
  const routes = path.resolve(import.meta.dirname, "..", "src", "routes");
  const missing: string[] = [];
  for (const file of fs.readdirSync(routes)) {
    for (const match of fs.readFileSync(path.join(routes, file), "utf8").matchAll(/app\.(get|post|put|delete)\(\s*"([^"]+)"/g)) {
      const route = match[2].replace(/:([A-Za-z]+)/g, "{$1}");
      // Media routes share one parameter block; compare on the path itself.
      if (!described.includes(`  ${route}:`)) missing.push(`${match[1].toUpperCase()} ${route}`);
    }
  }
  assert.deepEqual(missing, [], `routes missing from the OpenAPI file: ${missing.join(", ")}`);
});
