/**
 * How the machine the server runs on is doing: the processor, the memory, the temperatures, the disks (the card, a USB stick, an NVMe over PCIe) and the network cards, sampled every
 * few seconds and kept for a few minutes, so that Studio can draw them as a task manager does. Linux reads /proc and /sys (the CM5 and the Jetson); any other system gets what Node
 * itself can say (processor load, memory), and what is not there is simply left out. Read only: nothing here changes anything.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import os from "node:os";

export type DiskKind = "sd" | "usb" | "nvme" | "other";
export type MetricsSample = {
  at_ms: number;
  cpu: { percent: number | null; cores: number; load: [number, number, number]; mhz?: number };
  memory: { total: number; used: number; available: number; swap_total: number; swap_used: number };
  temperatures: Array<{ name: string; celsius: number }>;
  disks: Array<{ mount: string; device: string; kind: DiskKind; fs: string; total: number; used: number }>;
  network: Array<{ name: string; up: boolean; rx_bps: number | null; tx_bps: number | null; rx_bytes: number; tx_bytes: number }>;
  uptime_s: number;
};
export type MetricsPoint = { t: number; cpu: number | null; memory: number; swap: number; temperature: number | null; rx_bps: number; tx_bps: number };

// ---- the readers of /proc and /sys, each a pure function of the text it is given -----------------------------------------------------------------

/** The first line of /proc/stat: [busy, total] jiffies (idle and iowait count as not busy). */
export function parseProcStat(text: string): [number, number] | null {
  const line = text.split("\n").find(item => item.startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some(value => !Number.isFinite(value))) return null;
  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return [total - idle, total];
}

/** /proc/meminfo in bytes. */
export function parseMeminfo(text: string): MetricsSample["memory"] | null {
  const kib: Record<string, number> = {};
  for (const line of text.split("\n")) { const match = /^(\w+):\s+(\d+)/.exec(line); if (match) kib[match[1]] = Number(match[2]); }
  if (!kib.MemTotal) return null;
  const available = kib.MemAvailable ?? ((kib.MemFree ?? 0) + (kib.Buffers ?? 0) + (kib.Cached ?? 0));
  return { total: kib.MemTotal * 1024, used: (kib.MemTotal - available) * 1024, available: available * 1024, swap_total: (kib.SwapTotal ?? 0) * 1024, swap_used: ((kib.SwapTotal ?? 0) - (kib.SwapFree ?? 0)) * 1024 };
}

/** /proc/net/dev: bytes received and sent by each interface but the loopback. */
export function parseNetDev(text: string): Array<{ name: string; rx: number; tx: number }> {
  const out: Array<{ name: string; rx: number; tx: number }> = [];
  for (const line of text.split("\n").slice(2)) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === "lo") continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length >= 9 && Number.isFinite(fields[0]) && Number.isFinite(fields[8])) out.push({ name: match[1], rx: fields[0], tx: fields[8] });
  }
  return out;
}

const REAL_FILESYSTEMS = new Set(["ext2", "ext3", "ext4", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "btrfs", "xfs", "f2fs", "zfs", "hfsplus", "msdos"]);
export function diskKindOf(device: string): DiskKind {
  if (/^\/dev\/nvme/.test(device)) return "nvme";
  if (/^\/dev\/mmcblk/.test(device)) return "sd";
  if (/^\/dev\/(sd|vd|xvd)[a-z]/.test(device)) return "usb";
  return "other";
}

/** The mounted disks that hold files (not tmpfs, proc, overlays, snaps...), once each, from /proc/mounts. */
export function parseMounts(text: string): Array<{ device: string; mount: string; fs: string; kind: DiskKind }> {
  const seen = new Set<string>(), out: Array<{ device: string; mount: string; fs: string; kind: DiskKind }> = [];
  for (const line of text.split("\n")) {
    const [device, mountRaw, type] = line.split(" ");
    if (!device || !mountRaw || !type || !REAL_FILESYSTEMS.has(type) || !device.startsWith("/dev/")) continue;
    const mount = mountRaw.replace(/\\040/g, " ");
    if (mount.startsWith("/snap") || mount.startsWith("/var/lib/docker") || seen.has(device)) continue;
    seen.add(device);
    out.push({ device, mount, fs: type, kind: diskKindOf(device) });
  }
  return out;
}

const read = (file: string): string | null => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

function readTemperatures(): MetricsSample["temperatures"] {
  const out: MetricsSample["temperatures"] = [];
  try {
    for (const zone of fs.readdirSync("/sys/class/thermal").filter(name => name.startsWith("thermal_zone")).sort()) {
      const raw = read(`/sys/class/thermal/${zone}/temp`), type = read(`/sys/class/thermal/${zone}/type`)?.trim() || zone;
      const value = raw === null ? NaN : Number(raw.trim());
      if (Number.isFinite(value)) out.push({ name: type, celsius: Math.round(value / 100) / 10 });
    }
  } catch { /* no thermal zones: a PC, a container */ }
  return out;
}

function readDisks(): MetricsSample["disks"] {
  const mounts = read("/proc/mounts");
  if (mounts === null) return [];
  const out: MetricsSample["disks"] = [];
  for (const mount of parseMounts(mounts)) {
    try { const stat = fs.statfsSync(mount.mount); out.push({ ...mount, total: stat.blocks * stat.bsize, used: (stat.blocks - stat.bfree) * stat.bsize }); } catch { /* a disk that went away */ }
  }
  return out;
}

export class SystemMonitor {
  readonly #history: MetricsPoint[] = [];
  #last: { at: number; cpu: [number, number] | null; net: Map<string, { rx: number; tx: number }> } | null = null;
  #sample: MetricsSample | null = null;
  #timer: NodeJS.Timeout | undefined;
  readonly #now: () => number;
  static readonly KEEP = 150;

  constructor(now: () => number = Date.now) { this.#now = now; }

  /** Sample now (the processor and the traffic are rates between two samples, so the first has none). */
  sample(): MetricsSample {
    const at = this.#now();
    const stat = read("/proc/stat");
    const cpuNow = stat ? parseProcStat(stat) : null;
    let percent: number | null = null;
    if (cpuNow && this.#last?.cpu && cpuNow[1] > this.#last.cpu[1]) percent = Math.round(1000 * (cpuNow[0] - this.#last.cpu[0]) / (cpuNow[1] - this.#last.cpu[1])) / 10;
    const memory = parseMeminfo(read("/proc/meminfo") ?? "") ?? { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem(), swap_total: 0, swap_used: 0 };
    const netText = read("/proc/net/dev");
    const counters = new Map((netText ? parseNetDev(netText) : []).map(item => [item.name, item]));
    const seconds = this.#last ? (at - this.#last.at) / 1000 : 0;
    const operstate = (name: string) => read(`/sys/class/net/${name}/operstate`)?.trim() === "up";
    const network = [...counters.values()].map(item => {
      const before = this.#last?.net.get(item.name);
      const rate = (now: number, was: number | undefined) => seconds >= 0.5 && was !== undefined && now >= was ? Math.round(8 * (now - was) / seconds) : null;
      return { name: item.name, up: operstate(item.name), rx_bps: rate(item.rx, before?.rx), tx_bps: rate(item.tx, before?.tx), rx_bytes: item.rx, tx_bytes: item.tx };
    });
    const [one, five, fifteen] = os.loadavg();
    const cpus = os.cpus();
    const sample: MetricsSample = {
      at_ms: at, cpu: { percent: percent ?? (cpuNow ? null : null), cores: cpus.length, load: [Math.round(one * 100) / 100, Math.round(five * 100) / 100, Math.round(fifteen * 100) / 100], ...(cpus[0]?.speed ? { mhz: cpus[0].speed } : {}) },
      memory, temperatures: readTemperatures(), disks: readDisks(), network, uptime_s: Math.round(os.uptime()),
    };
    this.#last = { at, cpu: cpuNow, net: new Map([...counters.values()].map(item => [item.name, { rx: item.rx, tx: item.tx }])) };
    this.#sample = sample;
    const hottest = sample.temperatures.length ? Math.max(...sample.temperatures.map(item => item.celsius)) : null;
    this.#history.push({
      t: at, cpu: percent, memory: sample.memory.total ? Math.round(1000 * sample.memory.used / sample.memory.total) / 10 : 0,
      swap: sample.memory.swap_total ? Math.round(1000 * sample.memory.swap_used / sample.memory.swap_total) / 10 : 0, temperature: hottest,
      rx_bps: network.reduce((sum, item) => sum + (item.rx_bps ?? 0), 0), tx_bps: network.reduce((sum, item) => sum + (item.tx_bps ?? 0), 0),
    });
    if (this.#history.length > SystemMonitor.KEEP) this.#history.splice(0, this.#history.length - SystemMonitor.KEEP);
    return sample;
  }

  /** Sample every `everyMs` while the server runs (the timer does not keep the process alive). */
  start(everyMs = 2000): void {
    if (this.#timer) return;
    this.sample();
    this.#timer = setInterval(() => { try { this.sample(); } catch { /* a failed sample is a missing point */ } }, everyMs);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; } }

  get current(): MetricsSample { return this.#sample ?? this.sample(); }
  get history(): readonly MetricsPoint[] { return this.#history; }
}
