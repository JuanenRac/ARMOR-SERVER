import assert from "node:assert/strict";
import test from "node:test";
import { AlarmZoneFeed, parseZoneLinks, zoneMessage, ZoneLinksInvalid } from "../src/alarm_zone_feed.js";
import type { Device } from "../src/devices/registry.js";
import { startServer, studioCookie } from "./helpers.js";

const door = (state: Device["state"], online = true): Device => ({ id: "door-1", kind: "door", online, state } as unknown as Device);

test("a link is validated: ids, no duplicates per zone, no unknown fields", () => {
  assert.deepEqual(parseZoneLinks([{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }]), [{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }]);
  assert.throws(() => parseZoneLinks([{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }, { device_id: "door-2", node_id: "alarm-1", zone_id: "z1" }]), ZoneLinksInvalid);
  assert.throws(() => parseZoneLinks([{ device_id: "Door 1", node_id: "alarm-1", zone_id: "z1" }]), ZoneLinksInvalid);
  assert.throws(() => parseZoneLinks([{ device_id: "d", node_id: "n", zone_id: "z", extra: 1 }]), ZoneLinksInvalid);
  assert.throws(() => parseZoneLinks("nope"), ZoneLinksInvalid);
});

test("the zone says normal, triggered or tamper (tamper first) and flags a low battery", () => {
  const link = { device_id: "door-1", node_id: "alarm-1", zone_id: "z1" };
  assert.deepEqual(zoneMessage(door({ open: false, battery: 80 }), link), { zone: "z1", state: "normal", battery_low: false });
  assert.deepEqual(zoneMessage(door({ open: true, battery: 10 }), link), { zone: "z1", state: "triggered", battery_low: true });
  assert.equal(zoneMessage(door({ open: true, tamper: true }), link).state, "tamper");
});

test("the feed tells the panel on a change and on the refresh, and stays silent for a device that does not answer", () => {
  const sent: Array<[string, string]> = [];
  let clock = 0;
  const devices = [door({ open: true })];
  const feed = new AlarmZoneFeed(`${process.env.TEMP ?? "/tmp"}/armor-zone-links-${process.pid}.json`, { publish: (topic, payload) => { sent.push([topic, payload]); }, devices: () => devices, refreshMs: 30_000, now: () => clock });
  feed.set([{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }]);
  assert.equal(sent.length, 1);   // setting the links tells the panel at once
  assert.equal(sent[0]![0], "armor/alarm/alarm-1/zigbee");
  assert.deepEqual(JSON.parse(sent[0]![1]), { zone: "z1", state: "triggered", battery_low: false });
  feed.handleDevice(door({ open: false }));
  assert.equal(JSON.parse(sent[1]![1]).state, "normal");
  feed.handleDevice({ ...door({ open: true }), id: "other" } as Device);
  assert.equal(sent.length, 2);   // another device is none of its business
  clock = 10_000; feed.tick(); assert.equal(sent.length, 2);   // not yet
  clock = 30_000; feed.tick(); assert.equal(sent.length, 3);   // due
  clock = 40_000; feed.tick(); assert.equal(sent.length, 3);   // not due yet
  clock = 65_000; feed.tick(); assert.equal(sent.length, 4);
  devices[0] = door({ open: true }, false);
  clock = 120_000; feed.tick(); assert.equal(sent.length, 4);   // offline: nothing is said
});

test("the links are read by an operator, set by an administrator only, and a bad body is a 400", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    assert.equal((await fetch(`${running.base}/api/v1/alarm/zone-links`, { headers: admin })).status, 200);
    const bad = await fetch(`${running.base}/api/v1/alarm/zone-links`, { method: "PUT", headers: admin, body: JSON.stringify({ links: [{ device_id: "X Y", node_id: "a", zone_id: "z" }] }) });
    assert.equal(bad.status, 400);
    const good = await fetch(`${running.base}/api/v1/alarm/zone-links`, { method: "PUT", headers: admin, body: JSON.stringify({ links: [{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }] }) });
    assert.equal(good.status, 200);
    const read = await (await fetch(`${running.base}/api/v1/alarm/zone-links`, { headers: admin })).json() as { links: unknown[] };
    assert.equal(read.links.length, 1);
    const viewer = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    assert.equal(viewer.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    const headers = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    assert.equal((await fetch(`${running.base}/api/v1/alarm/zone-links`, { method: "PUT", headers, body: JSON.stringify({ links: [] }) })).status, 403);
  } finally { await running.stop(); }
});
