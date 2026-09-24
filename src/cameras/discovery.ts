/**
 * Local camera-service discovery: probes the ordinary camera ports of one
 * private IPv4 /24 network. It sends no credentials and no commands, runs one
 * scan at a time and can be cancelled.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

export type DiscoveredCamera = { host: string; ports: number[] };
export const CAMERA_PORTS = [80, 554, 8000, 8080, 8899];

export const isPrivateIpv4 = (address: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

/** The /24 prefixes to scan: the configured CIDR, or every private network this host is on. */
export function discoveryPrefixes(configuredCidr: string | null, interfaces = networkInterfaces()): string[] {
  if (configuredCidr) {
    const match = /^(\d+\.\d+\.\d+)\.\d+\/24$/.exec(configuredCidr);
    if (!match) throw new Error("ARMOR_CAMERA_DISCOVERY_CIDR must use an IPv4 /24 CIDR");
    if (!isPrivateIpv4(`${match[1]}.1`)) throw new Error("camera discovery only scans private networks");
    return [match[1]];
  }
  const prefixes = new Set<string>();
  for (const entry of Object.values(interfaces).flat()) {
    if (entry && entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address)) prefixes.add(entry.address.split(".").slice(0, 3).join("."));
  }
  return [...prefixes];
}

export const openPort = (host: string, port: number, timeoutMs = 300): Promise<boolean> => new Promise(resolve => {
  const socket = createConnection({ host, port });
  const done = (result: boolean) => { socket.destroy(); resolve(result); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

export type ScanOptions = { prefixes: string[]; signal?: AbortSignal; probe?: (host: string, port: number) => Promise<boolean>; batchSize?: number };

export async function scanNetworks(options: ScanOptions): Promise<DiscoveredCamera[]> {
  const probe = options.probe ?? openPort;
  const hosts = options.prefixes.flatMap(prefix => Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`));
  const found: DiscoveredCamera[] = [];
  const batchSize = options.batchSize ?? 16;
  for (let start = 0; start < hosts.length; start += batchSize) {
    if (options.signal?.aborted) break;
    const results = await Promise.all(hosts.slice(start, start + batchSize).map(async host => {
      const ports = (await Promise.all(CAMERA_PORTS.map(port => probe(host, port).then(open => open ? port : null)))).filter((port): port is number => port !== null);
      return ports.length ? { host, ports } : null;
    }));
    found.push(...results.filter((item): item is DiscoveredCamera => item !== null));
  }
  return found;
}

/** Allows one scan at a time: a second request while one runs is refused, not queued. */
export class DiscoveryGate {
  #running = false;
  get running(): boolean { return this.#running; }
  async run<T>(work: () => Promise<T>): Promise<T | "busy"> {
    if (this.#running) return "busy";
    this.#running = true;
    try { return await work(); } finally { this.#running = false; }
  }
}
