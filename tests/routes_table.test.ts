// docs/ROUTES.md is generated from the code; a route added or changed without regenerating it fails here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script, not a typed module
import { render, routes } from "../tools/routes_table.mjs";

test("docs/ROUTES.md is current", () => {
  const file = path.resolve(import.meta.dirname, "..", "docs", "ROUTES.md");
  assert.equal(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), render());
});

test("every route the server registers is listed once, with who may call it", () => {
  const list = routes() as Array<{ method: string; route: string; access: string }>;
  assert.ok(list.length > 200);
  assert.equal(new Set(list.map(item => `${item.method} ${item.route}`)).size, list.length);
  const find = (method: string, route: string) => list.find(item => item.method === method && item.route === route);
  assert.equal(find("GET", "/api/v1/admin/node-panels")?.access, "administrator");
  assert.equal(find("POST", "/api/v1/cameras/:id/stream-ticket")?.access, "operator");
  assert.equal(find("GET", "/api/v1/site/versions")?.access, "operator");
  assert.equal(find("GET", "/api/v1/electrical/design/versions")?.access, "operator");
});

test("a node's own report is the kind of route that checks the caller by itself", () => {
  const list = routes() as Array<{ method: string; route: string; access: string }>;
  assert.equal(list.find(item => item.method === "POST" && item.route === "/api/v1/telemetry")?.access, "none here");
});
