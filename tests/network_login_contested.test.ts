import assert from "node:assert/strict";
import test from "node:test";
import { addressContested } from "../src/routes/network.js";

const NOW = 1_800_000_000_000;
const event = (kind: string, ago: number, device_id?: string) => ({ kind, at_ms: NOW - ago, ...(device_id ? { device_id } : {}) });

test("an address in conflict is no place to send a stored login", () => {
  assert.equal(addressContested({ timestamp_ms: NOW, events: [event("arp_conflict", 60_000, "cam-1")] }, "cam-1"), true);
  assert.equal(addressContested({ timestamp_ms: NOW, events: [event("arp_conflict", 60_000)] }, "cam-1"), true);
});

test("an old conflict, another device or another event does not hold a login back", () => {
  assert.equal(addressContested({ timestamp_ms: NOW, events: [event("arp_conflict", 11 * 60_000, "cam-1")] }, "cam-1"), false);
  assert.equal(addressContested({ timestamp_ms: NOW, events: [event("arp_conflict", 1000, "cam-2")] }, "cam-1"), false);
  assert.equal(addressContested({ timestamp_ms: NOW, events: [event("new_device", 1000, "cam-1")] }, "cam-1"), false);
  assert.equal(addressContested({ timestamp_ms: NOW }, "cam-1"), false);
});
