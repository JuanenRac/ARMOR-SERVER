import assert from "node:assert/strict";
import test from "node:test";
import { NetworkCommands } from "../src/network_commands.js";

test("an order whose answer was lost is offered again, but at most three times, and never once it has a result", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const queue = new NetworkCommands(() => new Date(now));
  const device = { id: "d1", ip: "192.168.0.7", mac: "aa:bb:cc:dd:ee:ff" } as never;
  const record = queue.enqueue("net-1", { type: "ping" }, device, "tester");
  assert.deepEqual(queue.take("net-1").map(command => command.id), [record.command.id]);
  assert.deepEqual(queue.take("net-1"), [], "not again at once");
  now += 26_000;
  assert.equal(queue.take("net-1").length, 1, "offered again after a while without a result");
  now += 26_000;
  assert.equal(queue.take("net-1").length, 1);
  now += 26_000;
  assert.equal(queue.take("net-1").length, 0, "three offers are the limit");
  const other = queue.enqueue("net-1", { type: "ping" }, device, "tester");
  queue.take("net-1");
  queue.record("net-1", [{ id: other.command.id, type: "ping", ok: true } as never]);
  now += 60_000;
  assert.ok(!queue.take("net-1").some(command => command.id === other.command.id), "an order with a result is not offered");
});
