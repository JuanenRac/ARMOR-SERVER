/**
 * Where a request comes from: the house (or its VPN) or the Internet. The answer decides how much is asked of a session (the second factor, the length of its life, a new proof for the
 * critical actions). It is only as good as the address the server sees: behind a reverse proxy that must be named in ARMOR_TRUST_PROXY, or every request looks like the proxy's own.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import net from "node:net";

export type Origin = "local" | "remote";
type Range = { family: 4 | 6; network: bigint; bits: number };

const toBigInt = (address: string): { family: 4 | 6; value: bigint } | undefined => {
  const plain = address.replace(/^::ffff:/i, "");
  if (net.isIPv4(plain)) return { family: 4, value: plain.split(".").reduce((total, part) => total * 256n + BigInt(part), 0n) };
  if (net.isIPv6(plain)) {
    const [head = "", tail = ""] = plain.split("::");
    const part = (text: string) => text === "" ? [] : text.split(":");
    const left = part(head), right = plain.includes("::") ? part(tail) : [];
    const groups = [...left, ...Array(plain.includes("::") ? 8 - left.length - right.length : 0).fill("0"), ...right];
    if (groups.length !== 8) return undefined;
    return { family: 6, value: groups.reduce((total, group) => total * 65536n + BigInt(`0x${group || "0"}`), 0n) };
  }
  return undefined;
};

/** Parses a list of CIDR blocks ("192.168.0.0/16, 10.66.0.0/24, ::1/128"); a block that is not one is a mistake in the settings. */
export function parseRanges(text: string): Range[] {
  const out: Range[] = [];
  for (const item of text.split(",").map(part => part.trim()).filter(Boolean)) {
    const [address = "", bitsText] = item.split("/");
    const parsed = toBigInt(address);
    const max = parsed?.family === 6 ? 128 : 32;
    const bits = bitsText === undefined ? max : /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : -1;
    if (!parsed || bits < 0 || bits > max) throw new Error(`"${item}" is not an address range (for example 192.168.0.0/16)`);
    const shift = BigInt(max - bits);
    out.push({ family: parsed.family, network: (parsed.value >> shift) << shift, bits });
  }
  return out;
}

export function inRanges(address: string | undefined, ranges: Range[]): boolean {
  const parsed = address ? toBigInt(address) : undefined;
  if (!parsed) return false;
  return ranges.some(range => {
    if (range.family !== parsed.family) return false;
    const max = range.family === 6 ? 128 : 32, shift = BigInt(max - range.bits);
    return (parsed.value >> shift) << shift === range.network;
  });
}

export const DEFAULT_LOCAL_NETWORKS = "192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,127.0.0.0/8,::1/128,fe80::/10,fc00::/7";

export function classify(address: string | undefined, local: Range[], vpn: Range[]): Origin {
  return inRanges(address, local) || inRanges(address, vpn) ? "local" : "remote";
}
