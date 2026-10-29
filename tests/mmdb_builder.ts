/**
 * Makes small MaxMind DB files for the tests: a search tree of 24-bit records over the prefixes given, and a data section where every address leads to `{ country: { iso_code } }`
 * (the key "country" is written once and pointed at, so the pointer form of the format is read too).
 */
import net from "node:net";
import { addressBytes } from "../src/geoip.js";

export type Prefix = { cidr: string; country: string };

const str = (text: string): Buffer => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length >= 29) throw new Error("long strings are not needed in tests");
  return Buffer.concat([Buffer.from([(2 << 5) | bytes.length]), bytes]);
};
const uint = (type: 5 | 6, value: number): Buffer => {
  const size = value === 0 ? 0 : value < 256 ? 1 : value < 65_536 ? 2 : value < 16_777_216 ? 3 : 4;
  const out = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) out[size - 1 - index] = (value >>> (8 * index)) & 0xFF;
  return Buffer.concat([Buffer.from([(type << 5) | size]), out]);
};
const map = (pairs: Buffer[]): Buffer => Buffer.concat([Buffer.from([(7 << 5) | (pairs.length / 2)]), ...pairs]);

export function buildMmdb(prefixes: Prefix[], options: { ipVersion?: 4 | 6; recordBits?: 24 | 28 | 32 } = {}): Buffer {
  const ipVersion = options.ipVersion ?? 6;
  const recordBits = options.recordBits ?? 24;
  // data section: "country" first, then one map per country
  const data: Buffer[] = [str("country")];
  let size = data[0]!.length;
  const offsets = new Map<string, number>();
  for (const { country } of prefixes) {
    if (offsets.has(country)) continue;
    const pointer = Buffer.from([0x20, 0x00]);   // a pointer (size 0) to offset 0, where "country" is
    const entry = map([pointer, map([str("iso_code"), str(country)])]);
    offsets.set(country, size);
    data.push(entry);
    size += entry.length;
  }
  // search tree
  type Slot = { node: number } | { data: string } | null;
  const nodes: Array<[Slot, Slot]> = [[null, null]];
  for (const { cidr, country } of prefixes) {
    const [address, lengthText] = cidr.split("/");
    const bytes = addressBytes(address!)!;
    let bits: number[] = [];
    for (let index = 0; index < bytes.length * 8; index += 1) bits.push((bytes[index >> 3]! >> (7 - (index & 7))) & 1);
    bits = bits.slice(0, Number(lengthText));
    if (ipVersion === 6 && bytes.length === 4) bits = [...Array<number>(96).fill(0), ...bits];
    if (ipVersion === 4 && net.isIP(address!) !== 4) throw new Error("an IPv6 prefix in a tree of IPv4");
    let node = 0;
    bits.forEach((bit, index) => {
      if (index === bits.length - 1) { nodes[node]![bit] = { data: country }; return; }
      let next = nodes[node]![bit];
      if (!next || !("node" in next)) { nodes.push([null, null]); next = { node: nodes.length - 1 }; nodes[node]![bit] = next; }
      node = next.node;
    });
  }
  const count = nodes.length;
  const record = (slot: Slot): number => (slot === null ? count : "node" in slot ? slot.node : count + 16 + offsets.get(slot.data)!);
  const nodeBytes = recordBits * 2 / 8;
  const tree = Buffer.alloc(count * nodeBytes);
  nodes.forEach(([left, right], index) => {
    const l = record(left), r = record(right), base = index * nodeBytes;
    if (recordBits === 24) { tree.writeUIntBE(l, base, 3); tree.writeUIntBE(r, base + 3, 3); }
    else if (recordBits === 32) { tree.writeUInt32BE(l, base); tree.writeUInt32BE(r, base + 4); }
    else {
      tree.writeUIntBE(l & 0xFFFFFF, base, 3);
      tree[base + 3] = (((l >>> 24) & 0x0F) << 4) | ((r >>> 24) & 0x0F);
      tree.writeUIntBE(r & 0xFFFFFF, base + 4, 3);
    }
  });
  const metadata = map([str("binary_format_major_version"), uint(5, 2), str("binary_format_minor_version"), uint(5, 0), str("ip_version"), uint(5, ipVersion),
    str("node_count"), uint(6, count), str("record_size"), uint(5, recordBits), str("database_type"), str("Test-Country")]);
  return Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from("\xAB\xCD\xEFMaxMind.com", "latin1"), metadata]);
}
