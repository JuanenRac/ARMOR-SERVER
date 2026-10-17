import assert from "node:assert/strict";
import test from "node:test";
import { counterStep, ElectricalEnergy } from "../src/electrical_energy.js";

// A "day" is counted in the time zone of the installation; this file counts it in UTC so that it means the same on every machine.
process.env.ARMOR_TZ = "UTC";

const at = (iso: string) => Date.parse(iso);

test("a counter adds the difference between two readings, wraps at the top of the meter and starts again after a reset", () => {
  assert.deepEqual(counterStep(10, 10.5), { kwh: 0.5, reset: false });
  const wrapped = counterStep(9999.5, 0.3);
  assert.equal(Math.round(wrapped.kwh * 100) / 100, 0.79);
  assert.equal(wrapped.reset, true);
  assert.deepEqual(counterStep(500, 2), { kwh: 2, reset: true });          // a node that lost power and began again
});

test("energy is added up per day, a reset never makes a negative day and a restart of the server loses nothing", () => {
  const energy = new ElectricalEnergy();
  energy.add("e1", "grid", 100, at("2000-01-01T23:00:00Z"));
  energy.add("e1", "grid", 101, at("2000-01-01T23:50:00Z"));
  energy.add("e1", "grid", 103, at("2000-01-02T01:00:00Z"));
  energy.add("e1", "grid", 0.5, at("2000-01-02T02:00:00Z"));               // reset
  energy.add("e1", "grid", "not a number", at("2000-01-02T03:00:00Z"));
  energy.add("e1", "heater", 5, at("2000-01-02T03:00:00Z"));
  const list = energy.list();
  const grid = list.find(item => item.channel === "grid")!;
  assert.deepEqual(grid.days, [{ day: "2000-01-01", kwh: 1, resets: 0 }, { day: "2000-01-02", kwh: 2.5, resets: 1 }]);
  assert.deepEqual(list.find(item => item.channel === "heater")!.days, []);   // one reading is only a starting point
  const again = new ElectricalEnergy();
  again.import(JSON.parse(JSON.stringify(energy.export())));
  again.add("e1", "grid", 1.5, at("2000-01-02T04:00:00Z"));
  assert.equal(again.list().find(item => item.channel === "grid")!.days[1].kwh, 3.5);
  again.import({ channels: { "bad": { last: 1, days: [] }, "x/y": { last: "no" as never, days: [{ day: "nope", kwh: 1 } as never] } } });
  assert.deepEqual(again.list().find(item => item.node === "x")?.days, []);
});
