import assert from "node:assert/strict";
import test from "node:test";
import { SystemMonitor, diskKindOf, parseMeminfo, parseMounts, parseNetDev, parseProcStat } from "../src/system_metrics.js";

test("/proc/stat gives busy and total jiffies, idle and iowait not counted as busy", () => {
  assert.deepEqual(parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1"), [150, 1000]);
  assert.equal(parseProcStat("nothing"), null);
  assert.equal(parseProcStat("cpu  a b c d"), null);
});

test("/proc/meminfo is read in bytes, with the available memory when the kernel tells it", () => {
  const memory = parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n");
  assert.deepEqual(memory, { total: 1024000, used: 614400, available: 409600, swap_total: 204800, swap_used: 51200 });
  assert.equal(parseMeminfo("garbage"), null);
});

test("/proc/net/dev lists the network cards without the loopback", () => {
  const text = "Inter-|   Receive\n face |bytes packets\n    lo: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n  eth0: 5000 5 0 0 0 0 0 0 7000 7 0 0 0 0 0 0\n";
  assert.deepEqual(parseNetDev(text), [{ name: "eth0", rx: 5000, tx: 7000 }]);
});

test("the disks that hold files are told apart by what they are plugged into", () => {
  assert.equal(diskKindOf("/dev/nvme0n1p2"), "nvme");
  assert.equal(diskKindOf("/dev/mmcblk0p2"), "sd");
  assert.equal(diskKindOf("/dev/sda1"), "usb");
  assert.equal(diskKindOf("/dev/mapper/x"), "other");
  const mounts = parseMounts("proc /proc proc rw 0 0\n/dev/mmcblk0p2 / ext4 rw 0 0\n/dev/sda1 /media/usb\\040disk vfat rw 0 0\n/dev/sda1 /again vfat rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/loop1 /snap/core squashfs ro 0 0\n");
  assert.deepEqual(mounts.map(item => [item.device, item.mount, item.kind]), [["/dev/mmcblk0p2", "/", "sd"], ["/dev/sda1", "/media/usb disk", "usb"]]);
});

test("the monitor keeps a bounded history and always answers with a sample", () => {
  let now = 1000;
  const monitor = new SystemMonitor(() => now);
  const first = monitor.sample();
  now += 2000;
  const second = monitor.sample();
  assert.ok(second.cpu.cores >= 1 && second.memory.total > 0);
  assert.equal(first.at_ms, 1000);
  assert.equal(monitor.history.length, 2);
  for (let index = 0; index < SystemMonitor.KEEP + 10; index++) { now += 2000; monitor.sample(); }
  assert.equal(monitor.history.length, SystemMonitor.KEEP);
});
