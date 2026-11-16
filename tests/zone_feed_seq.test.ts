import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmZoneFeed, ZoneFeedSigner } from "../src/alarm_zone_feed.js";
import type { Device } from "../src/devices/registry.js";
import { tempDir } from "./helpers.js";

const door = (id: string): Device => ({ id, kind: "door", online: true, state: { open: true } } as unknown as Device);

test("the signed zone messages of one panel carry a number that only goes up, even in the same millisecond or when the clock goes back", () => {
  const dir = tempDir();
  const signer = new ZoneFeedSigner(path.join(dir, "zone-feed.key"));
  const sent: Array<{ topic: string; seq: number; zone: string }> = [];
  let clock = 1_700_000_000_000;
  const feed = new AlarmZoneFeed(path.join(dir, "links.json"), {
    publish: (topic, payload) => { const message = JSON.parse(payload) as { seq?: number; zone?: string }; if (topic.endsWith("/zigbee")) sent.push({ topic, seq: message.seq ?? 0, zone: message.zone ?? "" }); },
    devices: () => [door("d1"), door("d2"), door("d3"), door("d4")], now: () => clock, signer: () => signer,
  });
  feed.set([
    { device_id: "d1", node_id: "alarm-1", zone_id: "z1" }, { device_id: "d2", node_id: "alarm-1", zone_id: "z2" },
    { device_id: "d3", node_id: "alarm-1", zone_id: "z3" }, { device_id: "d4", node_id: "alarm-2", zone_id: "z1" },
  ]);
  const of = (node: string) => sent.filter(item => item.topic === `armor/alarm/${node}/zigbee`).map(item => item.seq);
  const strictlyUp = (values: number[]) => values.every((value, index) => index === 0 || value > values[index - 1]!);
  assert.ok(of("alarm-1").length >= 3 && strictlyUp(of("alarm-1")), "three zones of one panel in one millisecond get three different numbers");
  assert.equal(of("alarm-2")[0], clock, "another panel keeps its own count, which starts at the clock");
  feed.refresh();
  clock -= 60_000;   // the clock of the server goes back (NTP)
  feed.refresh();
  assert.ok(of("alarm-1").length >= 9 && strictlyUp(of("alarm-1")), "a refresh and a clock that went back never repeat or lower a number");
  assert.ok(strictlyUp(of("alarm-2")));
});
