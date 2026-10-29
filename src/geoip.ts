/**
 * The country of an address, read from a MaxMind DB file (the free GeoLite2 Country database, or any file of that format) that the person downloads and puts on this machine. Nothing is
 * asked of anybody on the network: the lookup is a walk through the file, and the file is the only thing it ever reads. It is off unless ARMOR_GEOIP_DB names a file, and a file that is
 * missing, damaged or not of this format only turns the lookup off (the server logs why, once, with no address in it).
 *
 * Format (https://maxmind.github.io/MaxMind-DB/): a binary search tree of `node_count` nodes of two records each (24, 28 or 32 bits), sixteen zero bytes, a data section, and after a marker
 * the metadata map. A record below `node_count` is the next node, equal to it means "nothing here", above it points into the data section. Only what a country needs is read.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import net from "node:net";

export class GeoIpInvalid extends Error {}

const MARKER = Buffer.from("\xAB\xCD\xEFMaxMind.com", "latin1");
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

type Value = string | number | bigint | boolean | Value[] | { [key: string]: Value };

/** Decodes the values of the data section; every read is bounds-checked, so a damaged file throws GeoIpInvalid and never loops or reads outside itself. */
class Decoder {
  constructor(private readonly buffer: Buffer, private readonly base: number) {}

  /** The value at `offset` (relative to the start of this section) and the offset after it. */
  decode(offset: number, depth = 0): { value: Value; next: number } {
    if (depth > MAX_DEPTH) throw new GeoIpInvalid("data nested too deep");
    let at = this.base + offset;
    const byte = (index: number): number => {
      if (index < 0 || index >= this.buffer.length) throw new GeoIpInvalid("data outside the file");
      return this.buffer[index]!;
    };
    const control = byte(at++);
    let type = control >> 5;
    if (type === 1) {   // a pointer into the section
      const size = (control >> 3) & 3, low = control & 7;
      let target: number;
      if (size === 0) { target = (low << 8) | byte(at); at += 1; }
      else if (size === 1) { target = ((low << 16) | (byte(at) << 8) | byte(at + 1)) + 2048; at += 2; }
      else if (size === 2) { target = ((low << 24) | (byte(at) << 16) | (byte(at + 1) << 8) | byte(at + 2)) + 526_336; at += 3; }
      else { target = ((byte(at) << 24) | (byte(at + 1) << 16) | (byte(at + 2) << 8) | byte(at + 3)) >>> 0; at += 4; }
      // A pointer leads to a value; it never leads to another pointer in a well-made file, and following one at most once keeps a loop impossible.
      const inner = this.decode(target, depth + 1);
      return { value: inner.value, next: at - this.base };
    }
    if (type === 0) type = 7 + byte(at++);
    let size = control & 31;
    if (size === 29) { size = 29 + byte(at); at += 1; }
    else if (size === 30) { size = 285 + ((byte(at) << 8) | byte(at + 1)); at += 2; }
    else if (size === 31) { size = 65_821 + ((byte(at) << 16) | (byte(at + 1) << 8) | byte(at + 2)); at += 3; }
    const take = (length: number): Buffer => {
      if (at + length > this.buffer.length) throw new GeoIpInvalid("data outside the file");
      const piece = this.buffer.subarray(at, at + length);
      at += length;
      return piece;
    };
    switch (type) {
      case 2: return { value: take(size).toString("utf8"), next: at - this.base };
      case 3: { if (size !== 8) throw new GeoIpInvalid("bad double"); return { value: take(8).readDoubleBE(0), next: at - this.base }; }
      case 4: return { value: take(size).toString("hex"), next: at - this.base };
      case 5: case 6: case 8: case 9: case 10: {
        if (size > 16) throw new GeoIpInvalid("bad integer");
        const bytes = take(size);
        let number = 0n;
        for (const part of bytes) number = (number << 8n) | BigInt(part);
        return { value: number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number, next: at - this.base };
      }
      case 7: {
        if (size > MAX_ITEMS) throw new GeoIpInvalid("map too large");
        const map: { [key: string]: Value } = {};
        let cursor = at - this.base;
        for (let index = 0; index < size; index += 1) {
          const key = this.decode(cursor, depth + 1);
          if (typeof key.value !== "string") throw new GeoIpInvalid("map key is not a string");
          const item = this.decode(key.next, depth + 1);
          map[key.value] = item.value;
          cursor = item.next;
        }
        return { value: map, next: cursor };
      }
      case 11: {
        if (size > MAX_ITEMS) throw new GeoIpInvalid("array too large");
        const list: Value[] = [];
        let cursor = at - this.base;
        for (let index = 0; index < size; index += 1) { const item = this.decode(cursor, depth + 1); list.push(item.value); cursor = item.next; }
        return { value: list, next: cursor };
      }
      case 14: return { value: size !== 0, next: at - this.base };
      case 15: { if (size !== 4) throw new GeoIpInvalid("bad float"); return { value: take(4).readFloatBE(0), next: at - this.base }; }
      default: throw new GeoIpInvalid(`unknown data type ${type}`);
    }
  }
}

export class GeoIpDatabase {
  readonly #buffer: Buffer;
  readonly #nodeCount: number;
  readonly #recordBits: number;
  readonly #treeBytes: number;
  readonly #ipVersion: number;
  readonly #data: Decoder;
  #ipv4Start: number | undefined;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
    const marker = buffer.lastIndexOf(MARKER);
    if (marker < 0) throw new GeoIpInvalid("not a MaxMind DB file");
    const meta = new Decoder(buffer, marker + MARKER.length).decode(0).value;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new GeoIpInvalid("bad metadata");
    const number = (name: string): number => {
      const item = (meta as Record<string, Value>)[name];
      if (typeof item !== "number") throw new GeoIpInvalid(`metadata has no ${name}`);
      return item;
    };
    this.#nodeCount = number("node_count");
    this.#recordBits = number("record_size");
    this.#ipVersion = number("ip_version");
    if (![24, 28, 32].includes(this.#recordBits)) throw new GeoIpInvalid("unsupported record size");
    if (this.#ipVersion !== 4 && this.#ipVersion !== 6) throw new GeoIpInvalid("unsupported ip version");
    if (number("binary_format_major_version") !== 2) throw new GeoIpInvalid("unsupported format version");
    this.#treeBytes = (this.#recordBits * 2 / 8) * this.#nodeCount;
    if (this.#treeBytes + 16 > marker) throw new GeoIpInvalid("search tree larger than the file");
    this.#data = new Decoder(buffer.subarray(0, marker), this.#treeBytes + 16);
  }

  static open(file: string): GeoIpDatabase {
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) throw new GeoIpInvalid("file too large");
    return new GeoIpDatabase(fs.readFileSync(file));
  }

  #record(node: number, side: 0 | 1): number {
    const bytes = this.#buffer;
    const bits = this.#recordBits;
    const base = node * (bits / 4);
    if (bits === 24) return bytes.readUIntBE(base + side * 3, 3);
    if (bits === 32) return bytes.readUInt32BE(base + side * 4);
    const middle = bytes[base + 3]!;
    return side === 0 ? (((middle & 0xF0) << 20) | bytes.readUIntBE(base, 3)) >>> 0 : (((middle & 0x0F) << 24) | bytes.readUIntBE(base + 4, 3)) >>> 0;
  }

  /** The node at which an IPv4 address starts in a tree of IPv6 (96 zero bits down), found once. */
  #startOfIpv4(): number {
    if (this.#ipv4Start !== undefined) return this.#ipv4Start;
    let node = 0;
    if (this.#ipVersion === 6) for (let bit = 0; bit < 96 && node < this.#nodeCount; bit += 1) node = this.#record(node, 0);
    this.#ipv4Start = node;
    return node;
  }

  /** The record of an address as 4 or 16 bytes, as the data section value it leads to (undefined when the file has nothing for it). */
  #find(address: Buffer): Value | undefined {
    if (address.length === 16 && this.#ipVersion === 4) return undefined;   // an IPv6 address in a tree of IPv4
    let node = address.length === 4 ? this.#startOfIpv4() : 0;
    const bits = address.length * 8;
    for (let bit = 0; bit < bits && node < this.#nodeCount; bit += 1) {
      node = this.#record(node, ((address[bit >> 3]! >> (7 - (bit & 7))) & 1) as 0 | 1);
    }
    if (node === this.#nodeCount) return undefined;
    if (node < this.#nodeCount) return undefined;
    const offset = node - this.#nodeCount - 16;
    if (offset < 0) throw new GeoIpInvalid("record points outside the data");
    return this.#data.decode(offset).value;
  }

  /** The ISO 3166-1 alpha-2 country of an address in its usual text form, or undefined when the file does not know it (or it is not an address). */
  country(address: string): string | undefined {
    const bytes = addressBytes(address);
    if (!bytes) return undefined;
    let record: Value | undefined;
    try { record = this.#find(bytes); } catch (error) { if (error instanceof GeoIpInvalid) return undefined; throw error; }
    if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
    for (const key of ["country", "registered_country"]) {
      const entry = (record as Record<string, Value>)[key];
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const code = (entry as Record<string, Value>).iso_code;
        if (typeof code === "string" && /^[A-Z]{2}$/.test(code)) return code;
      }
    }
    return undefined;
  }
}

/** The 4 or 16 bytes of an address; an IPv4 address written as IPv6 ("::ffff:a.b.c.d") is read as the IPv4 one it is. */
export function addressBytes(address: string): Buffer | undefined {
  const bracketed = /^\[(.*)\]$/.exec(address.trim());
  const text = (bracketed ? bracketed[1]! : address.trim()).replace(/%.*$/, "");
  const family = net.isIP(text);
  if (family === 4) return Buffer.from(text.split(".").map(part => Number(part)));
  if (family !== 6) return undefined;
  let head = text, tail = "";
  const tailV4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let v4: number[] = [];
  if (tailV4) { v4 = tailV4[1]!.split(".").map(Number); head = text.slice(0, text.length - tailV4[1]!.length) + "0:0"; }
  const parts = head.split("::");
  if (parts.length > 2) return undefined;
  const words = (part: string): number[] => (part === "" ? [] : part.split(":").map(word => parseInt(word, 16)));
  const left = words(parts[0]!), right = parts.length === 2 ? words(parts[1]!) : [];
  const fill = 8 - left.length - right.length;
  if (parts.length === 1 ? left.length !== 8 : fill < 0) return undefined;
  const all = [...left, ...Array<number>(parts.length === 2 ? fill : 0).fill(0), ...right];
  if (all.length !== 8 || all.some(word => Number.isNaN(word) || word < 0 || word > 0xFFFF)) return undefined;
  if (tailV4) { all[6] = (v4[0]! << 8) | v4[1]!; all[7] = (v4[2]! << 8) | v4[3]!; }
  const bytes = Buffer.alloc(16);
  all.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  const mapped = bytes.subarray(0, 10).every(value => value === 0) && bytes[10] === 0xFF && bytes[11] === 0xFF;
  return mapped ? bytes.subarray(12) : bytes;
}
