import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ARMOR_PORTS } from "../src/armor-ports.js";
import { readConfig } from "../src/config.js";
import { CATALOG } from "../src/services.js";
import { SECRETS } from "./helpers.js";

const shared = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "generated", "armor-ports.ts");

test("src/armor-ports.ts is what ARMOR-COMMON generates now", { skip: fs.existsSync(shared) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const norm = (text: string) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  assert.equal(norm(fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "armor-ports.ts"), "utf8")), norm(fs.readFileSync(shared, "utf8")));
});

test("the server listens, by default, on the port of the one numbering and the catalog of services names the same ports", () => {
  assert.equal(readConfig({ ...SECRETS }).port, ARMOR_PORTS.server);
  assert.equal(readConfig({ ...SECRETS, ARMOR_PORT: "18123" }).port, 18123);
  const ports = Object.fromEntries(CATALOG.filter((entry) => entry.port !== undefined).map((entry) => [entry.id, entry.port]));
  assert.deepEqual(ports, { server: ARMOR_PORTS.server, studio: ARMOR_PORTS.studio, broker: ARMOR_PORTS.mqtt, "voice-ai": ARMOR_PORTS.voice });
});

test("the files that start the server say the same port as the registry", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, new RegExp(`ARMOR_PORT=${ARMOR_PORTS.server} `));
  assert.match(dockerfile, new RegExp(`EXPOSE ${ARMOR_PORTS.server}`));
  assert.match(fs.readFileSync(path.join(root, ".env.example"), "utf8"), new RegExp(`^ARMOR_PORT=${ARMOR_PORTS.server}$`, "m"));
});
