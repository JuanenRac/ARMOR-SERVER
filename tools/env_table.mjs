// Writes docs/ENVIRONMENT.md: every setting the server reads from its environment, taken from the code (config.ts and the other sources) and from the explained example file.
// Run `node tools/env_table.mjs` to write it and `node tools/env_table.mjs --check` to see whether it is current (the test suite does).
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []);
// Read only by the tests, to point the server at a local stand-in.
const TEST_ONLY = new Set(["ARMOR_ADMIN_NODE_PORT", "ARMOR_TELEGRAM_API", "ARMOR_FIRMWARE_RELEASE_API"]);

export function render() {
  const read = new Set();
  const limits = new Map();
  for (const file of walk(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/env\.(ARMOR_[A-Z0-9_]+)/g)) read.add(match[1]);
    for (const match of text.matchAll(/integer\(env, "(ARMOR_[A-Z0-9_]+)", ([^,]+), ([^,]+), ([^)]+)\)/g)) { read.add(match[1]); limits.set(match[1], { fallback: match[2].trim(), min: match[3].trim(), max: match[4].trim() }); }
  }
  const described = new Map();
  let comment = [];
  let fresh = false;   // the last line was a variable: the next comment starts a new explanation
  let previous = "";
  for (const raw of fs.readFileSync(path.join(root, ".env.example"), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const variable = /^#? ?((?:ARMOR|TLS)_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (variable) {
      if (!described.has(variable[1])) described.set(variable[1], { example: variable[2], text: comment.join(" ") || previous });
      if (comment.length) previous = comment.join(" ");
      fresh = true;
      comment = [];
      continue;
    }
    if (line.startsWith("#") && !line.startsWith("# ---")) { if (fresh) { fresh = false; previous = ""; } comment.push(line.replace(/^#\s?/, "")); } else { comment = []; fresh = false; previous = ""; }
  }
  const names = [...new Set([...read].filter(name => !TEST_ONLY.has(name)).concat([...described.keys()]))].sort();
  const cell = text => text.replace(/\|/g, "\|").replace(/\s+/g, " ").trim();
  const rows = names.map(name => {
    const info = described.get(name) ?? { example: "", text: "" };
    const limit = limits.get(name);
    const range = limit ? `integer ${limit.min.replace(/_/g, "")} to ${limit.max.replace(/_/g, "")}, default ${limit.fallback.replace(/_/g, "")}` : "";
    return `| \`${name}\` | ${cell(range)} | ${cell(info.example ? `\`${info.example}\`` : "")} | ${cell(info.text)} |`;
  });
  return ["# Settings of the server", "", "Every setting is an environment variable (a `.env` file next to the server is read too). This table is generated from the code and from `.env.example`: change those, not this file.", "",
    "| Variable | Allowed values | Example | What it does |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(root, "docs", "ENVIRONMENT.md");
  const text = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) { console.error("docs/ENVIRONMENT.md is out of date: run node tools/env_table.mjs"); process.exit(1); }
    console.log("ENV_TABLE=CURRENT");
  } else { fs.writeFileSync(target, text); console.log("ENV_TABLE=WRITTEN"); }
}
