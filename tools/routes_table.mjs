// Writes docs/ROUTES.md: every route the server registers, taken from the code (the file that registers it and who may call it).
// Run `node tools/routes_table.mjs` to write it and `node tools/routes_table.mjs --check` to see whether it is current (the test suite does).
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []);

/** What each guard in front of a route means, from the strongest down; a route with none of them answers whoever asks (or checks by itself). */
const ACCESS = [["requireAdmin", "administrator"], ["requireAi", "AI service"], ["requireOperator", "operator"], ["requireSession", "signed-in user"]];
const ROUTE = /(?:app|router)\.(get|post|put|patch|delete)\(\s*(["`])([^"`]+)\2\s*,([^\n]*)/g;

export function routes() {
  const found = [];
  for (const file of walk(path.join(root, "src")).sort()) {
    const text = fs.readFileSync(file, "utf8");
    const area = path.relative(path.join(root, "src"), file).replace(/\\/g, "/");
    for (const match of text.matchAll(ROUTE)) {
      const [, method, , route, rest] = match;
      const guards = rest.slice(0, rest.indexOf("=>") >= 0 ? rest.indexOf("=>") : rest.length);
      const access = ACCESS.find(([name]) => guards.includes(name))?.[1] ?? "none here";
      // A route written for several designs at once (`${prefix}/versions`) is listed once for each prefix the file loops over.
      const prefixes = route.includes("${prefix}") ? [...text.matchAll(/\["(\/api\/v1\/[^"]+)", \w+, "\w+"\]/g)].map(item => item[1]) : [null];
      for (const prefix of prefixes) found.push({ method: method.toUpperCase(), route: prefix ? route.replace("${prefix}", prefix) : route, access, area, elevated: guards.includes("requireElevated") });
    }
  }
  return found.sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}

export function render() {
  const rows = routes().map(item => `| ${item.method} | \`${item.route}\` | ${item.access}${item.elevated ? ", fresh proof of identity" : ""} | \`${item.area}\` |`);
  return ["# Routes of the server", "",
    "Every route the code registers, with who may call it and the file that registers it. This table is generated from the code: change the code, not this file. A route marked `none here` answers whoever asks or checks the caller by itself (a node's token, a sign-in, a stream ticket); the contract of each one is in the OpenAPI description of ARMOR-COMMON.", "",
    "| Method | Route | Who may call it | Registered in |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(root, "docs", "ROUTES.md");
  const text = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) { console.error("docs/ROUTES.md is out of date: run node tools/routes_table.mjs"); process.exit(1); }
    console.log("ROUTES_TABLE=CURRENT");
  } else { fs.writeFileSync(target, text); console.log("ROUTES_TABLE=WRITTEN"); }
}
