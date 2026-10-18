// Every ARMOR_* variable the server reads is named in .env.example, so that nobody has to read the source to find a setting.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Read only by the tests, to point the server at a local stand-in.
const TEST_ONLY = new Set(["ARMOR_ADMIN_NODE_PORT", "ARMOR_TELEGRAM_API", "ARMOR_FIRMWARE_RELEASE_API"]);

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []);

test(".env.example names every ARMOR_ variable the source reads", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = new Set<string>();
  for (const file of walk(path.join(root, "src"))) for (const match of fs.readFileSync(file, "utf8").matchAll(/env\.(ARMOR_[A-Z0-9_]+)/g)) read.add(match[1]!);
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const missing = [...read].filter(name => !TEST_ONLY.has(name) && !new RegExp(`^#? ?${name}=`, "m").test(example));
  assert.deepEqual(missing, []);
});
