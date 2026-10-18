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

// The HTTP contract of ARMOR-COMMON describes exactly the routes this server registers, each with its method and a typed answer.
const openapi = path.resolve(directory, "..", "openapi", "armor-server.yaml");
const sources = path.resolve(import.meta.dirname, "..", "src");
const METHODS = ["get", "post", "put", "patch", "delete"];

/** (method, path) of every operation the contract lists, read from its regular layout (a path at two spaces, a method at four, a response at eight). */
function described(text: string): { operations: Set<string>; untyped: string[] } {
  const operations = new Set<string>(), untyped: string[] = [];
  const lines = text.split(/\r?\n/);
  let route = "", method = "";
  lines.forEach((line, index) => {
    const path = /^ {2}(\/\S*):$/.exec(line);
    if (path) { route = path[1]; method = ""; return; }
    const verb = /^ {4}(get|post|put|patch|delete):/.exec(line);
    if (verb) { method = verb[1]; operations.add(`${method} ${route}`); return; }
    const answer = /^ {8}'(\d{3})':/.exec(line);
    if (answer && method && answer[1] !== "204" && !lines.slice(index, line.endsWith(":") ? index + 4 : index + 1).some(part => part.includes("content:"))) untyped.push(`${method.toUpperCase()} ${route} ${answer[1]}`);
  });
  return { operations, untyped };
}

/** (method, path) of every route registered in the sources: literal paths, the ones registered in a loop over a list of names, and the panel proxy. */
function registered(): Set<string> {
  const found = new Set<string>();
  const files = [...fs.readdirSync(path.join(sources, "routes")).map(name => path.join(sources, "routes", name)), path.join(sources, "node_panel_proxy.ts")];
  const shape = (route: string) => route.replace(/:([A-Za-z]+)/g, "{$1}");
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      let routes = [match[3]];
      const template = /\$\{(\w+)\}/.exec(match[3]);
      if (template) {
        const loops = [...text.slice(0, match.index).matchAll(/for \(const \[?([^\]]*?)\]? of \[([\s\S]*?)\](?: as const)?\) \{/g)];
        const loop = loops[loops.length - 1];
        const names = loop[1].split(",").map(name => name.trim());
        const options = names.length > 1 ? [...loop[2].matchAll(/\[\s*"([^"]+)"/g)].map(item => item[1]) : [...loop[2].matchAll(/"([^"]+)"/g)].map(item => item[1]);
        assert.ok(options.length > 0, `cannot expand ${match[3]} in ${path.basename(file)}`);
        routes = options.map(option => match[3].replace(`\${${template[1]}}`, option));
      }
      for (const route of routes) found.add(`${match[1]} ${shape(route)}`);
    }
    for (const match of text.matchAll(/\bapp\.all\(\[([^\]]+)\]/g)) {
      for (const item of match[1].matchAll(/"([^"]+)"/g)) {
        if (item[1].endsWith("/panel")) continue; // the bare panel address is the same operation as the one with a path
        for (const method of ["get", "post", "put", "delete"]) found.add(`${method} ${shape(item[1]).replace("*rest", "{path}")}`);
      }
    }
  }
  return found;
}

test("the routes the server registers are the operations the OpenAPI contract describes, by method and path", { skip: fs.existsSync(openapi) ? false : "ARMOR-COMMON OpenAPI is not available" }, () => {
  const { operations } = described(fs.readFileSync(openapi, "utf8"));
  const routes = registered();
  assert.ok(routes.size > 150, `the route table was not read (${routes.size})`);
  assert.ok(METHODS.every(method => [...routes].some(route => route.startsWith(`${method} `))), "a method was not found in the sources");
  assert.deepEqual([...routes].filter(route => !operations.has(route)).sort(), [], "registered but not described");
  assert.deepEqual([...operations].filter(route => !routes.has(route)).sort(), [], "described but not registered");
});

test("every answer in the OpenAPI contract says what its body is", { skip: fs.existsSync(openapi) ? false : "ARMOR-COMMON OpenAPI is not available" }, () => {
  assert.deepEqual(described(fs.readFileSync(openapi, "utf8")).untyped, []);
});
