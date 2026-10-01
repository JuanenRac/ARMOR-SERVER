import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameSplitter } from "../src/media/relay.js";

const part = (body: string) => `--armorframe\r\nContent-type: image/jpeg\r\nContent-length: ${body.length}\r\n\r\n${body}\r\n`;

test("the splitter hands out whole pictures and keeps the latest", () => {
  const splitter = new FrameSplitter();
  const stream = Buffer.from(part("AAAA") + part("BBBB") + part("CC"));
  const out: string[] = [];
  for (let at = 0; at < stream.length; at += 7) for (const frame of splitter.push(stream.subarray(at, at + 7))) out.push(frame.toString());
  assert.deepEqual(out, [part("AAAA"), part("BBBB")]);        // the third is not complete until a boundary follows it
  assert.equal(splitter.latest?.toString(), part("BBBB"));
});

test("a stream that starts in the middle of a picture begins at the next boundary", () => {
  const splitter = new FrameSplitter();
  const frames = splitter.push(Buffer.from("tail of an old one\r\n" + part("XX") + "--armorframe"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.toString(), part("XX"));
});
