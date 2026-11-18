// The small modules every other part leans on, tested on their own: the path the gates read, the durable rename and the backup copy, the calendar day in a time zone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dayOf, secondOfDay } from "../src/day.js";
import { durableRename, keepBackup } from "../src/durable.js";
import { gatePath } from "../src/gate_path.js";

const folder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "armor-small-"));

/** Runs `work` with ARMOR_TZ set to `zone` (or unset) and puts the old value back. */
function inZone<T>(zone: string | undefined, work: () => T): T {
  const before = process.env.ARMOR_TZ;
  if (zone === undefined) delete process.env.ARMOR_TZ; else process.env.ARMOR_TZ = zone;
  try { return work(); } finally { if (before === undefined) delete process.env.ARMOR_TZ; else process.env.ARMOR_TZ = before; }
}

test("the gates read a path in lower case and without the slashes at its end, so another spelling does not walk around them", () => {
  assert.equal(gatePath("/API/V1/Users/"), "/api/v1/users");
  assert.equal(gatePath("/api/v1/users///"), "/api/v1/users");
  assert.equal(gatePath("/Api/V1/Admin/Node-Panels/Radar-1/Ticket"), "/api/v1/admin/node-panels/radar-1/ticket");
  assert.equal(gatePath("/"), "");
  assert.equal(gatePath(""), "");
  assert.equal(gatePath("/a//b"), "/a//b", "only the end is trimmed");
});

test("a rename over a file leaves the new content under the old name and no temporary file", () => {
  const dir = folder();
  try {
    const target = path.join(dir, "state.json"), temporary = `${target}.tmp`;
    fs.writeFileSync(target, "old");
    fs.writeFileSync(temporary, "new");
    durableRename(temporary, target);
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.equal(fs.existsSync(temporary), false);
    // the target did not exist yet
    const fresh = path.join(dir, "fresh.json");
    fs.writeFileSync(`${fresh}.tmp`, "first");
    durableRename(`${fresh}.tmp`, fresh);
    assert.equal(fs.readFileSync(fresh, "utf8"), "first");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["fresh.json", "state.json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a rename of a file that is not there is an error and touches nothing", () => {
  const dir = folder();
  try {
    const target = path.join(dir, "keep.json");
    fs.writeFileSync(target, "kept");
    assert.throws(() => durableRename(path.join(dir, "missing.tmp"), target));
    assert.equal(fs.readFileSync(target, "utf8"), "kept");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the last good copy is kept next to the file, replaced each time, and its absence is not an error", () => {
  const dir = folder();
  try {
    const target = path.join(dir, "users.json");
    assert.doesNotThrow(() => keepBackup(target));
    assert.equal(fs.existsSync(`${target}.bak`), false);
    fs.writeFileSync(target, "one");
    keepBackup(target);
    assert.equal(fs.readFileSync(`${target}.bak`, "utf8"), "one");
    fs.writeFileSync(target, "two");
    keepBackup(target);
    assert.equal(fs.readFileSync(`${target}.bak`, "utf8"), "two");
    assert.equal(fs.readFileSync(target, "utf8"), "two", "the file itself is not touched");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the calendar day and the second of the day follow ARMOR_TZ, not the machine", () => {
  const moment = Date.UTC(2026, 0, 31, 23, 30, 15);   // 23:30:15 UTC
  assert.equal(inZone("UTC", () => dayOf(moment)), "2026-01-31");
  assert.equal(inZone("UTC", () => secondOfDay(moment)), 23 * 3600 + 30 * 60 + 15);
  assert.equal(inZone("Asia/Tokyo", () => dayOf(moment)), "2026-02-01", "nine hours ahead: already the next day");
  assert.equal(inZone("Asia/Tokyo", () => secondOfDay(moment)), 8 * 3600 + 30 * 60 + 15);
  assert.equal(inZone("America/Los_Angeles", () => dayOf(moment)), "2026-01-31");
  assert.equal(inZone("America/Los_Angeles", () => secondOfDay(moment)), 15 * 3600 + 30 * 60 + 15);
  assert.equal(inZone("UTC", () => secondOfDay(Date.UTC(2026, 0, 31, 0, 0, 0))), 0, "midnight is the second 0, not 86400");
  assert.equal(inZone("UTC", () => secondOfDay(Date.UTC(2026, 0, 31, 23, 59, 59))), 86_399);
});

test("a time zone that does not exist, or none, falls back to the one of the machine instead of failing", () => {
  const moment = Date.UTC(2026, 5, 15, 12, 0, 0);
  const machine = inZone(undefined, () => dayOf(moment));
  assert.match(machine, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(inZone("Not/AZone", () => dayOf(moment)), machine);
  assert.equal(inZone("   ", () => dayOf(moment)), machine, "blank is none");
  assert.equal(inZone("Not/AZone", () => secondOfDay(moment)), inZone(undefined, () => secondOfDay(moment)));
});

test("asking for many different zones keeps giving the right day", () => {
  const moment = Date.UTC(2026, 6, 1, 12, 0, 0);
  const zones = ["UTC", "Europe/Madrid", "Europe/Lisbon", "Europe/Berlin", "Europe/Paris", "Europe/Rome", "Asia/Tokyo", "Asia/Shanghai", "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/Sao_Paulo", "Africa/Cairo", "Australia/Sydney", "Asia/Kolkata", "Atlantic/Azores", "Pacific/Honolulu", "Asia/Dubai"];
  for (const zone of zones) assert.equal(inZone(zone, () => dayOf(moment)), "2026-07-01", zone);
  assert.equal(inZone("Pacific/Auckland", () => dayOf(moment)), "2026-07-02", "twelve hours ahead in July: noon in Greenwich is already the next midnight");
  assert.equal(inZone("Pacific/Auckland", () => dayOf(Date.UTC(2026, 6, 1, 11, 59, 59))), "2026-07-01");
  assert.equal(inZone("UTC", () => dayOf(moment)), "2026-07-01", "the first zone still works after the cache was cleared");
});
