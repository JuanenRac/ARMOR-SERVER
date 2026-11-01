// The long memory of the readings (history.ts), tested directly: the five-minute averages (CoarseTier) and the file that holds a document whole (JsonFile).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COARSE_EVERY_MS, COARSE_KEEP, CoarseTier, JsonFile, type Sample } from "../src/history.js";
import { tempDir } from "./helpers.js";

const BUCKET = 7 * COARSE_EVERY_MS;

test("samples of one bucket are averaged, text keeps the last one, and the bucket closes when a later one comes", () => {
  const tier = new CoarseTier();
  tier.add({ t: BUCKET + 1000, power_w: 100, state: "a" });
  tier.add({ t: BUCKET + 2000, power_w: 200, state: "b" });
  assert.equal(tier.samples.length, 0, "the bucket is still open");
  assert.deepEqual(tier.all(), [{ t: BUCKET + COARSE_EVERY_MS / 2, power_w: 150, state: "b" }], "the open bucket is shown as it stands");
  tier.add({ t: BUCKET + COARSE_EVERY_MS + 1, power_w: 10 });
  assert.deepEqual(tier.samples, [{ t: BUCKET + COARSE_EVERY_MS / 2, power_w: 150, state: "b" }]);
  assert.equal(tier.all().length, 2);
});

test("the average is rounded to three decimals and a key that only some samples have is averaged over all of them", () => {
  const tier = new CoarseTier();
  tier.add({ t: BUCKET, v: 1 });
  tier.add({ t: BUCKET + 1, v: 1 });
  tier.add({ t: BUCKET + 2, v: 2 });
  tier.add({ t: BUCKET + COARSE_EVERY_MS, v: 0 });
  assert.equal(tier.samples[0]!.v, 1.333);
});

test("a bucket saved while it was still open and filled again after a restart leaves one point, not two", () => {
  const tier = new CoarseTier();
  tier.load([{ t: BUCKET + COARSE_EVERY_MS / 2, power_w: 50 }]);
  tier.add({ t: BUCKET + 10, power_w: 70 });
  tier.add({ t: BUCKET + COARSE_EVERY_MS, power_w: 1 });
  assert.deepEqual(tier.samples.filter(sample => sample.t === BUCKET + COARSE_EVERY_MS / 2), [{ t: BUCKET + COARSE_EVERY_MS / 2, power_w: 70 }]);
});

test("the tier keeps at most a month, the oldest first to go, and load keeps the newest", () => {
  const tier = new CoarseTier();
  const many: Sample[] = Array.from({ length: COARSE_KEEP + 5 }, (_, index) => ({ t: index * COARSE_EVERY_MS, v: index }));
  tier.load(many);
  assert.equal(tier.samples.length, COARSE_KEEP);
  assert.equal(tier.samples[0]!.v, 5);
  const live = new CoarseTier();
  for (let index = 0; index < COARSE_KEEP + 3; index += 1) live.add({ t: index * COARSE_EVERY_MS + 1, v: index });
  live.add({ t: (COARSE_KEEP + 3) * COARSE_EVERY_MS, v: 0 });
  assert.equal(live.samples.length, COARSE_KEEP);
  assert.equal(live.samples[0]!.v, 3, "the three oldest went");
});

test("property: whatever arrives in order, the closed buckets are in time order, one per time, and every number lies between the smallest and the largest that came in", () => {
  let seed = 4;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  for (let round = 0; round < 50; round += 1) {
    const tier = new CoarseTier();
    let t = BUCKET, low = Infinity, high = -Infinity;
    for (let step = 0; step < 200; step += 1) {
      t += random(200_000);
      const v = random(1000) / 4;
      low = Math.min(low, v); high = Math.max(high, v);
      tier.add({ t, v });
    }
    const all = tier.all();
    for (let i = 1; i < all.length; i += 1) assert.ok(all[i]!.t > all[i - 1]!.t, "strictly increasing");
    for (const sample of all) assert.ok((sample.v as number) >= low - 1e-9 && (sample.v as number) <= high + 1e-9);
  }
});

test("a JsonFile reads nothing from a file that is not there or is damaged, and writes the whole document through a temporary file", () => {
  const dir = tempDir();
  const file = new JsonFile<{ a: number }>(path.join(dir, "deep", "doc.json"));
  assert.equal(file.read(), undefined);
  file.write({ a: 1 });
  assert.deepEqual(file.read(), { a: 1 });
  assert.deepEqual(fs.readdirSync(path.join(dir, "deep")), ["doc.json"], "no temporary file is left");
  file.write({ a: 2 });
  assert.deepEqual(file.read(), { a: 2 });
  fs.writeFileSync(path.join(dir, "deep", "doc.json"), "{ not json");
  assert.equal(file.read(), undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "deep", "doc.json")).mode & 0o077, 0, "only the owner can read it");
});
