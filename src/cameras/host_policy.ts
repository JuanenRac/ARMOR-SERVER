/**
 * Where the server may open a connection on behalf of a camera. The address of a camera is typed by an operator and only checked to look like a host name, so a "camera" could
 * be the loopback, the metadata service of a cloud machine or a host on the Internet, with the stored login sent to it. While the option `cameras.allow_public_hosts` is on (the
 * default, as it always was) nothing changes; with it off a connection is made only to an address of the house (10/8, 172.16/12, 192.168/16, a unique local IPv6 address): the
 * loopback, the link-local range and every public address are refused, and a host NAME is checked on the address it resolves to when the connection is made.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";

let allowPublic: () => boolean = () => true;

/** The context tells where the option is read from (a function, so a change in Studio takes effect at once). */
export function setCameraHostPolicy(allow: () => boolean): void { allowPublic = allow; }

/** Whether an IP address is one of the house: private IPv4 ranges, or a unique local IPv6 address (and an IPv4 one written in the IPv6 form). */
export function isHouseAddress(address: string): boolean {
  const text = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  const ip = mapped ?? text;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(ip) === 6 && /^f[cd][0-9a-f]{2}:/.test(ip);
}

const refused = (): NodeJS.ErrnoException => Object.assign(new Error("the address of the camera is not an address of the house"), { code: "EACCES" });

/** A lookup that refuses what is not of the house, for the connection of a host NAME (the address it resolves to at that moment is the one that is checked). */
export const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address as never, family as never);
    const list = Array.isArray(address) ? address : [{ address: String(address), family: family ?? 4 }];
    if (list.length === 0 || !list.every(item => isHouseAddress(item.address))) return callback(refused(), "" as never, 4);
    return callback(null, address as never, family as never);
  });
};

/** What to connect to for a camera: the host and port as they are while public hosts are allowed; otherwise the same with the check of the resolved address, and for an address
 *  that is written as numbers and is not of the house a name that cannot resolve, so that the connection fails the same way. */
export function cameraTarget(host: string, port: number): { host: string; port: number; lookup?: LookupFunction } {
  if (allowPublic()) return { host, port };
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return isHouseAddress(bare) ? { host, port } : { host: "refused.invalid", port, lookup: (_name, _options, callback) => callback(refused(), "" as never, 4) };
  return { host, port, lookup: checkedLookup };
}

/** Whether the address typed for a camera may be stored: while public hosts are allowed any host name; otherwise a house address as numbers or a name that resolves to one. */
export async function cameraHostAllowed(host: string): Promise<boolean> {
  if (allowPublic()) return true;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return isHouseAddress(bare);
  try {
    const found = await dns.promises.lookup(host, { all: true });
    return found.length > 0 && found.every(item => isHouseAddress(item.address));
  } catch { return false; }
}
