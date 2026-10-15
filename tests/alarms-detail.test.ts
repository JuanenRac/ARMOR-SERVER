import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules, cleanDetail } from "../src/alarms.js";
import { tempDir } from "./helpers.js";

const centre = () => new AlarmCentre({ file: path.join(tempDir(), "alarms.json") });

test("the detail of an alarm keeps only short plain facts", () => {
  assert.equal(cleanDetail(undefined), undefined);
  assert.equal(cleanDetail({}), undefined);
  const clean = cleanDetail({ ip: "192.168.0.7", port: 23, risky: true, name: "x".repeat(500), nested: { a: 1 }, "Bad Key": "no", empty: "", nan: Number.NaN });
  assert.deepEqual(Object.keys(clean ?? {}).sort(), ["ip", "name", "port", "risky"]);
  assert.equal((clean?.name as string).length, 200);
});

test("an open alarm's facts can be kept up to date, a closed one's cannot", () => {
  const alarms = centre();
  alarms.raise("k", { source: { type: "network", id: "n" }, severity: "warning", code: "network_degraded", detail: { loss_percent: 25 } });
  alarms.update("k", { loss_percent: 40, latency_ms: 500 });
  assert.deepEqual(alarms.active()[0].detail, { loss_percent: 40, latency_ms: 500 });
  alarms.clear("k");
  alarms.update("k", { loss_percent: 1 });
  assert.equal(alarms.active()[0].detail?.loss_percent, 40);
});

test("one alarm can be taken off the list, open or closed, and clearing the record takes what was acknowledged, ended or not", () => {
  const alarms = centre();
  const raise = (key: string) => alarms.raise(key, { source: { type: "network", id: "n" }, severity: "warning", code: "network_port_opened" })!;
  const seenAndEnded = raise("a"), seenAndGoingOn = raise("b"), unseen = raise("c"), single = raise("d");
  alarms.acknowledge(seenAndEnded.id, "admin"); alarms.clear("a");
  alarms.acknowledge(seenAndGoingOn.id, "admin");
  assert.equal(alarms.remove(single.id)?.id, single.id);
  assert.equal(alarms.remove(single.id), undefined, "it is gone");
  assert.equal(alarms.clearAcknowledged(), 2);
  assert.deepEqual(alarms.active().map(alarm => alarm.id), [unseen.id], "only the one nobody has seen is left");
});

test("the alarms of the network say which device, which address, which MAC, which port", () => {
  const alarms = centre();
  const rules = new AlarmRules(alarms, () => "disarmed");
  const describe = (id: string) => ({ device: "Camera of the garage", ip: "192.168.0.211", mac: id, vendor: "Hikvision" });
  rules.handleNetworkEvent("n1", { id: "e1", kind: "port_opened", at_ms: 1_790_000_000_000, device_id: "aa:bb:cc:00:00:01", port: 23 }, () => false, describe);
  rules.handleNetworkEvent("n1", { id: "e2", kind: "arp_conflict", at_ms: 1_790_000_000_000, device_id: "aa:bb:cc:00:00:02", detail: "the router is now answered by 11:22:33:44:55:66; before by aa:bb:cc:00:00:02" }, () => false, describe);
  const byCode = Object.fromEntries(alarms.active().map(alarm => [alarm.code, alarm.detail]));
  assert.equal(byCode.network_port_opened?.port, 23);
  assert.equal(byCode.network_port_opened?.risky, true);
  assert.equal(byCode.network_port_opened?.device, "Camera of the garage");
  assert.equal(byCode.network_port_opened?.ip, "192.168.0.211");
  assert.equal(byCode.network_arp_conflict?.mac_now, "11:22:33:44:55:66");
  assert.equal(byCode.network_arp_conflict?.mac_before, "aa:bb:cc:00:00:02");
});

test("disarming ends the intrusion alarms and settles them: they go to the record, not on waiting for a second click", () => {
  const alarms = centre();
  const rules = new AlarmRules(alarms, () => "armed");
  alarms.raise("door", { source: { type: "device", id: "d1" }, severity: "high", code: "door_open" });
  alarms.raise("intr", { source: { type: "node", id: "n1" }, severity: "critical", code: "intrusion" });
  alarms.raise("net", { source: { type: "network", id: "n" }, severity: "warning", code: "network_port_opened" });
  rules.handleEvent({ type: "mode", mode: "disarmed" } as never);
  assert.deepEqual(alarms.active().map(alarm => alarm.code), ["network_port_opened"], "the others are not about the mode: they stay");
  assert.deepEqual(alarms.recent().map(alarm => [alarm.code, alarm.acknowledged_by]).sort(), [["door_open", "disarm"], ["intrusion", "disarm"]]);
});

test("an alarm taken off the list while its cause goes on does not come back until the cause ends and happens again", () => {
  const alarms = centre();
  const info = { source: { type: "network", id: "n" } as const, severity: "warning" as const, code: "network_port_opened" };
  const first = alarms.raise("k", info)!;
  alarms.acknowledge(first.id, "admin");
  assert.equal(alarms.raise("k", info), undefined, "acknowledged and still going on: one alarm, not two");
  assert.equal(alarms.remove(first.id)?.id, first.id);
  assert.equal(alarms.raise("k", info), undefined, "deleted while the cause goes on: the same report does not bring it back");
  alarms.clear("k");
  assert.ok(alarms.raise("k", info), "the cause ended and happened again: it is news again");
  const second = alarms.active()[0];
  alarms.acknowledge(second.id, "admin");
  assert.equal(alarms.clearAcknowledged(), 1);
  assert.equal(alarms.raise("k", info), undefined, "clearing the record does not bring back what is still going on either");
});

test("a burst of minor alarms never pushes off the list one that is still going on or that nobody has seen", () => {
  const alarms = centre();
  const critical = alarms.raise("alarm:alarm-1:sounding", { source: { type: "alarm", id: "alarm-1" }, severity: "critical", code: "alarm_sounding" });
  assert.ok(critical);
  for (let index = 0; index < 600; index += 1) {   // a big LAN: 600 devices that were never seen, each raised and then gone
    alarms.raise(`network:new:${index}`, { source: { type: "network", id: `net-1/${index}` }, severity: "warning", code: "network_new_device" });
    alarms.clear(`network:new:${index}`);
    if (index % 2 === 0) alarms.acknowledge(`alm-${String(index + 2).padStart(5, "0")}`, "tester");
  }
  assert.ok(alarms.active().some(alarm => alarm.id === critical.id), "the critical alarm is still on the list");
  assert.ok(alarms.active().length + alarms.recent().length <= 401, "and the list was kept to its size");
  // the ones dropped were over: an alarm that is still going on is never one of them
  const open = alarms.raise("network:open", { source: { type: "network", id: "net-1" }, severity: "warning", code: "network_degraded" });
  for (let index = 0; index < 450; index += 1) {
    alarms.raise(`device:${index}`, { source: { type: "device", id: `d${index}` }, severity: "warning", code: "tamper" });
  }
  assert.ok(alarms.active().some(alarm => alarm.id === open?.id), "an open alarm is not dropped while there is anything over to drop, nor while the list is under the hard limit");
  assert.ok(alarms.active().length >= 451, "450 alarms still going on are all kept");
});

test("an alarm that is going on and unseen is acknowledged before it can be taken off the list", async () => {
  const { startServer, studioCookie } = await import("./helpers.js");
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const raised = running.app.context.alarms.raise("test:one", { source: { type: "device", id: "smoke-1" }, severity: "critical", code: "smoke" });
    assert.ok(raised);
    const del = () => fetch(`${running.base}/api/v1/alarms/${raised.id}`, { method: "DELETE", headers: { cookie } });
    const refused = await del();
    assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [409, "acknowledge_first"]);
    await fetch(`${running.base}/api/v1/alarms/${raised.id}/acknowledge`, { method: "POST", headers: { cookie } });
    assert.equal((await del()).status, 200);
  } finally { await running.stop(); }
});

test("arming looks at what was already wrong: a node that is silent, a camera that is down and a door left open raise their alarms then", async () => {
  const { startServer, studioCookie } = await import("./helpers.js");
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const context = running.app.context;
    context.devices.create({ id: "front-door", name: "Front door", kind: "door", protocol: "wifi", source: { type: "push" }, commands: {} });
    context.devices.applyState("front-door", { open: true });
    context.store.telemetry({ node_id: "north-1", timestamp_ms: Date.now(), lux: 10, targets: [] });
    context.store.health({ node_id: "north-1", timestamp_ms: Date.now() + 1, online: false });
    assert.deepEqual(context.alarms.active().map(alarm => alarm.code), [], "disarmed: none of this matters yet");
    assert.equal((await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "armed" }) })).status, 200);
    const codes = context.alarms.active().map(alarm => alarm.code).sort();
    assert.deepEqual(codes, ["door_open", "node_down"], "armed with a node down and a door open");
  } finally { await running.stop(); }
});
