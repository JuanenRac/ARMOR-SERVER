import assert from "node:assert/strict";
import test from "node:test";
import { GeoIpDatabase, GeoIpInvalid } from "../src/geoip.js";
import { buildMmdb, map, str } from "./mmdb_builder.js";

// The decoder of the data section reads every type of the format. The tests put one odd value in the metadata map (which the constructor decodes whole) and see whether the file opens or is refused.
const PREFIXES = [{ cidr: "1.0.0.0/8", country: "ES" }];
const opens = (value: Buffer): GeoIpDatabase => new GeoIpDatabase(buildMmdb(PREFIXES, { extraMetadata: [str("x"), value] }));
const refused = (value: Buffer, why: string): void => {
  assert.throws(() => opens(value), (error: unknown) => error instanceof GeoIpInvalid, why);
};
const control = (type: number, size: number): Buffer => (type < 8 ? Buffer.from([(type << 5) | size]) : Buffer.from([size, type - 7]));

test("every type of the format is read when the value is well made", () => {
  assert.ok(opens(Buffer.concat([control(3, 8), Buffer.alloc(8)])), "a double");
  assert.ok(opens(Buffer.concat([control(15, 4), Buffer.alloc(4)])), "a float");
  assert.ok(opens(control(14, 1)), "a boolean true");
  assert.ok(opens(control(14, 0)), "a boolean false");
  assert.ok(opens(Buffer.concat([control(4, 3), Buffer.from([1, 2, 3])])), "bytes");
  assert.ok(opens(Buffer.concat([control(9, 3), Buffer.from([1, 2, 3])])), "a 64-bit integer that fits a number");
  assert.ok(opens(Buffer.concat([control(10, 9), Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])])), "an integer too big for a number is kept as a big integer");
  assert.ok(opens(Buffer.concat([control(11, 2), str("a"), str("b")])), "an array");
  assert.ok(opens(map([str("k"), map([str("deeper"), str("v")])])), "a map inside a map");
});

test("the sizes of the long forms are read (29, 30 and 31 as the first byte of the size)", () => {
  const long = (length: number, header: Buffer): Buffer => Buffer.concat([header, Buffer.alloc(length, 0x61)]);
  assert.ok(opens(long(40, Buffer.from([(2 << 5) | 29, 40 - 29]))), "a string of 40 bytes");
  assert.ok(opens(long(300, Buffer.from([(2 << 5) | 30, 0, 300 - 285]))), "a string of 300 bytes");
  assert.ok(opens(long(65_900, Buffer.from([(2 << 5) | 31, 0, 0, 65_900 - 65_821]))), "a string of 65 900 bytes");
});

test("a damaged value is refused and never read outside the file", () => {
  refused(Buffer.concat([control(3, 4), Buffer.alloc(4)]), "a double must have 8 bytes");
  refused(Buffer.concat([control(15, 2), Buffer.alloc(2)]), "a float must have 4 bytes");
  refused(Buffer.concat([control(9, 17), Buffer.alloc(17)]), "an integer of more than 16 bytes");
  refused(control(12, 0), "a type that the reader does not know");
  refused(Buffer.concat([Buffer.from([(2 << 5) | 20]), Buffer.from("short")]), "a string that is cut by the end of the file");
  refused(Buffer.from([(7 << 5) | 30, 0x12, 0x6B]), "a map that claims more than 4096 pairs");
  refused(Buffer.from([0x0B, 0x04, 0xFF]), "an array whose size is out of range");
  refused(map([Buffer.from([(5 << 5) | 1, 7]), str("v")]), "a map whose key is not a string");
});

test("a pointer that leads outside the file is refused, in all four sizes of the pointer", () => {
  refused(Buffer.from([(1 << 5) | 0, 0xFF]), "a pointer of one byte after the control");
  refused(Buffer.from([(1 << 5) | (1 << 3) | 7, 0xFF, 0xFF]), "a pointer of two bytes");
  refused(Buffer.from([(1 << 5) | (2 << 3) | 7, 0xFF, 0xFF, 0xFF]), "a pointer of three bytes");
  refused(Buffer.from([(1 << 5) | (3 << 3), 0x7F, 0xFF, 0xFF, 0xFF]), "a pointer of four bytes");
});

test("data nested too deep is refused instead of followed", () => {
  let value = str("end");
  for (let level = 0; level < 20; level += 1) value = map([str("n"), value]);
  refused(value, "20 maps inside one another");
});
