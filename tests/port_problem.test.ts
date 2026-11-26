// A serial port of a solar node that hears bytes and reads nothing: the line the node writes is read back, kept while the node repeats it, and shown with the node's health.
import assert from "node:assert/strict";
import test from "node:test";
import { NodeHealthStore, parseNodeHealth } from "../src/node_health.js";
import { PORT_PROBLEM_KEEP_MS, currentPortProblems, notePortProblem, parsePortProblem, type KeptPortProblem } from "../src/port_problem.js";

const LINE = "armor-ports: port 3 unreadable flat 115200bd rx16 tx15 n230 [00 00 00 00 00 00]";

test("the line a node writes about an unreadable port is read back", () => {
  assert.deepEqual(parsePortProblem(LINE), { port: 3, cause: "flat", baud: 115200, rx: 16, tx: 15, inverted: false, bytes_heard: 230, sample: "00 00 00 00 00 00" });
  assert.deepEqual(parsePortProblem("armor-ports: port 10 unreadable noise 2400bd rx-1 tx-1 inv n7 [9A 13]"), { port: 10, cause: "noise", baud: 2400, rx: -1, tx: -1, inverted: true, bytes_heard: 7, sample: "9A 13" });
  assert.equal(parsePortProblem("port 1 unreadable echo 9600bd rx4 tx5 n5 []")?.sample, "");
  for (const other of [undefined, "", "armor-mqtt: the broker refused the identity", "armor-ports: port 3 could not be opened (pins): it stays off",
    "armor-ports: port 0 unreadable flat 115200bd rx16 tx15 n1 [00]", "armor-ports: port 3 unreadable broken 115200bd rx16 tx15 n1 [00]",
    "armor-ports: port 3 unreadable flat 115200bd rx16 tx15 n230 [00 00 00", "armor-ports: port 3 unreadable flat 115200bd rx16 tx15 n230 [00] and more"]) {
    assert.equal(parsePortProblem(other), undefined, String(other));
  }
});

test("the time of a port is renewed only by a new line, and a port not said again goes away", () => {
  const kept = new Map<number, KeptPortProblem>();
  notePortProblem(kept, LINE, 1_000);
  notePortProblem(kept, LINE, 500_000);
  notePortProblem(kept, "armor-mqtt: something else", 600_000);
  assert.equal(currentPortProblems(kept, 1_000 + PORT_PROBLEM_KEEP_MS).length, 1);
  assert.equal(currentPortProblems(kept, 1_001 + PORT_PROBLEM_KEEP_MS).length, 0);
  notePortProblem(kept, LINE.replace("n230", "n240"), 2_000_000);
  notePortProblem(kept, "armor-ports: port 1 unreadable echo 9600bd rx4 tx5 n5 []", 2_000_000);
  assert.deepEqual(currentPortProblems(kept, 2_000_000).map(item => `${item.port}:${item.bytes_heard}`), ["1:5", "3:240"]);
});

test("the health of a solar node lists its unreadable ports, and a restart forgets them", () => {
  let now = 1_000_000;
  const store = new NodeHealthStore({ now: () => now });
  const report = (more: Record<string, unknown>) => parseNodeHealth({ kind: "node_health", node_id: "solar-1", timestamp_ms: now, family: "solar", firmware: "0.7.2", uptime_s: 1000, reset_reason: "power_on",
    heap_free: 100000, heap_min: 50000, link: "wifi", link_up: true, broker_reconnects: 1, ...more });
  assert.equal(store.ingest(report({})).port_problems, undefined);
  now += 60_000;
  const view = store.ingest(report({ uptime_s: 1060, last_error: LINE }));
  assert.equal(view.port_problems?.length, 1);
  assert.equal(view.port_problems?.[0]?.port, 3);
  now += 60_000;
  assert.equal(store.ingest(report({ uptime_s: 1120 })).port_problems?.length, 1, "another report without the line keeps it");
  now += 60_000;
  assert.equal(store.ingest(report({ uptime_s: 20 })).port_problems, undefined);
});
