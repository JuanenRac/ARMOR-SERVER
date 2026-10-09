import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SiteStore } from "../src/site.js";
import { tempDir } from "./helpers.js";

const house = (openings: number, features = 3) => ({
  schema: "armor-studio/site/1",
  openings: Array.from({ length: openings }, (_, index) => ({ id: `window-${index}` })),
  features: Array.from({ length: features }, (_, index) => ({ id: `tree-${index}` })),
});

function store() {
  let now = Date.parse("2026-10-01T10:00:00.000Z");
  const instance = new SiteStore(path.join(tempDir(), "site.json"), () => new Date(now));
  return { instance, advance: (ms: number) => { now += ms; } };
}

test("a design keeps the version it had before a save, but not one per save", () => {
  const { instance, advance } = store();
  let saved = instance.save(house(15), 0, "admin");           // the first save has nothing before it
  assert.equal(instance.versions().length, 0);
  advance(1_000);
  saved = instance.save(house(16), saved.revision, "admin");   // the first change keeps what there was
  assert.equal(instance.versions().length, 1);
  advance(1_000);
  saved = instance.save(house(17), saved.revision, "admin");   // a second one a second later keeps nothing more
  assert.equal(instance.versions().length, 1);
  advance(6 * 60_000);
  instance.save(house(18), saved.revision, "admin");           // but after five minutes it does
  assert.equal(instance.versions().length, 2);
  const [newest] = instance.versions();
  assert.equal(newest.counts.openings, 17);
  assert.equal(newest.counts.features, 3);
});

test("a save that takes a lot away keeps what was there at once, whenever it comes", () => {
  const { instance, advance } = store();
  let saved = instance.save(house(15), 0, "admin");
  advance(1_000);
  saved = instance.save(house(15, 4), saved.revision, "admin");
  const before = instance.versions().length;
  advance(1_000);
  instance.save(house(0, 4), saved.revision, "admin");         // every opening gone, one second after the last save
  assert.equal(instance.versions().length, before + 1);
  assert.equal(instance.versions()[0].counts.openings, 15, "the version has the openings that were just lost");
});

test("a version can be read whole, and an id that is not one is refused", () => {
  const { instance, advance } = store();
  let saved = instance.save(house(15), 0, "admin");
  advance(1_000);
  instance.save(house(2), saved.revision, "admin");
  const [version] = instance.versions();
  const whole = instance.version(version.id);
  assert.equal((whole?.site?.openings as unknown[]).length, 15);
  assert.equal(instance.version("../site"), null);
  assert.equal(instance.version("2026-10-01T10-00-00-000Z_r99"), null);
});

test("old versions are pruned: the latest 48 stay, and one of each past day", () => {
  const { instance, advance } = store();
  let saved = instance.save(house(10), 0, "admin");
  for (let index = 0; index < 120; index += 1) {               // 120 saves, each six minutes after the one before
    advance(6 * 60_000);
    saved = instance.save(house(10, 3 + (index % 2)), saved.revision, "admin");
  }
  const kept = instance.versions();
  assert.ok(kept.length >= 48 && kept.length <= 52, `kept ${kept.length}`);
});

test("a version can be forgotten one at a time or all together, and the current design stays", () => {
  const { instance, advance } = store();
  let saved = instance.save(house(10), 0, "admin");
  for (let index = 0; index < 3; index += 1) { advance(6 * 60_000); saved = instance.save(house(11 + index), saved.revision, "admin"); }
  const [newest, ...others] = instance.versions();
  assert.equal(others.length, 2);
  assert.equal(instance.deleteVersion(newest.id), true);
  assert.equal(instance.deleteVersion(newest.id), false);          // already gone
  assert.equal(instance.deleteVersion("../site"), false);          // not an id of a version
  assert.equal(instance.versions().length, 2);
  assert.equal(instance.deleteVersions(), 2);
  assert.equal(instance.versions().length, 0);
  assert.equal(instance.deleteVersions(), 0);
  assert.equal((instance.get().site?.openings as unknown[]).length, 13);   // the design itself was not touched
});
