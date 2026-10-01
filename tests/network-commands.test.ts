import assert from "node:assert/strict";
import test from "node:test";
import { CommandInvalid, NetworkCommands } from "../src/network_commands.js";
import type { NetworkDevice, NetworkResult } from "../src/network.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const NOW = 1_790_000_000_000;
const device = (extra: Partial<NetworkDevice> = {}): NetworkDevice => ({ id: "aa:bb:cc:00:00:01", ip: "192.168.0.50", mac: "aa:bb:cc:00:00:01", online: true, first_seen_ms: NOW - 5_000, last_seen_ms: NOW, ...extra });
const state = (extra: Record<string, unknown> = {}, devices: NetworkDevice[] = [device()]) => ({
  kind: "network", node_id: "network-1", timestamp_ms: NOW, interface: { name: "eth0", ip: "192.168.0.10", cidr: "192.168.0.0/24", gateway: "192.168.0.1" },
  internet: { state: "up", latency_ms: 12 }, devices, ...extra,
});

test("an order waits for the node, is handed out once, and its result is matched to it", () => {
  let now = Date.parse("2026-10-01T10:00:00Z");
  const commands = new NetworkCommands(() => new Date(now));
  assert.throws(() => commands.enqueue("n", { type: "reboot" }, undefined, "admin"), CommandInvalid);
  assert.throws(() => commands.enqueue("n", { type: "ping" }, undefined, "admin"), /device the node knows/);
  assert.throws(() => commands.enqueue("n", { type: "wake" }, device({ mac: undefined }), "admin"), /no MAC/);
  assert.throws(() => commands.enqueue("n", { type: "http", port: 70_000 }, device(), "admin"), /port/);
  const sweep = commands.enqueue("n", { type: "scan_now" }, undefined, "admin");
  const ping = commands.enqueue("n", { type: "ping" }, device(), "admin");
  assert.equal(ping.command.ip, "192.168.0.50");
  assert.deepEqual(commands.take("other"), [], "an order is for one node");
  assert.deepEqual(commands.take("n").map(item => item.id), [sweep.command.id, ping.command.id]);
  assert.deepEqual(commands.take("n"), [], "handed out once");
  const result: NetworkResult = { id: ping.command.id, type: "ping", ok: true, finished_ms: 5, latency_ms: 1.2 };
  assert.equal(commands.record("n", [result, { id: "cffffffffff", type: "ping", ok: true, finished_ms: 5 }, { ...result, type: "ports" }]), 1, "a result for an order nobody gave, or of another kind, is ignored");
  assert.equal(commands.get(ping.command.id)?.status, "done");
  assert.equal(commands.record("n", [result]), 0, "and one read twice counts once");
  const late = commands.enqueue("n", { type: "scan_now" }, undefined, "admin");
  now += 3 * 60_000;
  assert.equal(commands.get(late.command.id)?.status, "expired", "an order the node never took is forgotten");
});

test("an operator hands the node an order, the node gets it in the answer and reports, and Studio reads the result", async () => {
  const running = await startServer();
  try {
    const ingest = (body: unknown) => fetch(`${running.base}/api/v1/network/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    const first = await (await ingest(state())).json() as { commands: unknown[] };
    assert.deepEqual(first.commands, []);
    const cookie = await studioCookie(running.base);
    const headers = { "Content-Type": "application/json", cookie };
    assert.equal((await fetch(`${running.base}/api/v1/network/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "scan_now" }) })).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/network/commands`, { method: "POST", headers, body: JSON.stringify({ type: "format_disk" }) })).status, 400);
    const asked = await fetch(`${running.base}/api/v1/network/commands`, { method: "POST", headers, body: JSON.stringify({ type: "ping", device_id: "aa:bb:cc:00:00:01" }) });
    assert.equal(asked.status, 202);
    const { id } = await asked.json() as { id: string };
    const second = await (await ingest(state())).json() as { commands: Array<{ id: string; type: string; ip: string }> };
    assert.deepEqual(second.commands.map(item => [item.id, item.type, item.ip]), [[id, "ping", "192.168.0.50"]]);
    assert.deepEqual(((await (await ingest(state())).json()) as { commands: unknown[] }).commands, [], "once");
    assert.equal((await ingest(state({ results: [{ id, type: "ping", ok: true, finished_ms: NOW, latency_ms: 1.4, device_id: "aa:bb:cc:00:00:01" }] }))).status, 202);
    const read = await (await fetch(`${running.base}/api/v1/network/commands/${id}`, { headers: { cookie } })).json() as { status: string; result?: { latency_ms: number } };
    assert.equal(read.status, "done");
    assert.equal(read.result?.latency_ms, 1.4);
    assert.equal((await fetch(`${running.base}/api/v1/network/commands/cdeadbeef00`, { headers: { cookie } })).status, 404);
  } finally { await running.stop(); }
});

test("a device can be hidden from the list, and a watched device tells once when it comes back", async () => {
  const running = await startServer();
  try {
    const ingest = (body: unknown) => fetch(`${running.base}/api/v1/network/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    const cookie = await studioCookie(running.base);
    const headers = { "Content-Type": "application/json", cookie };
    const put = (body: unknown) => fetch(`${running.base}/api/v1/network/devices/aa:bb:cc:00:00:01`, { method: "PUT", headers, body: JSON.stringify(body) });
    const listed = async (hidden = false) => (await (await fetch(`${running.base}/api/v1/network${hidden ? "?hidden=1" : ""}`, { headers: { cookie } })).json()) as { nodes: Array<{ devices: unknown[]; hidden: number }> };
    await ingest(state({ public: { ip: "203.0.113.9", org: "AS64496 EXAMPLE", checked_ms: NOW } }));
    assert.equal((await listed()).nodes[0].devices.length, 1);
    assert.equal((await put({ hidden: true })).status, 200);
    let view = await listed();
    assert.deepEqual([view.nodes[0].devices.length, view.nodes[0].hidden], [0, 1]);
    assert.equal((await listed(true)).nodes[0].devices.length, 1, "it is still there when asked for");
    assert.equal((await put({ hidden: false, watch: true })).status, 200);
    assert.equal((await listed()).nodes[0].devices.length, 1);
    // it goes away and comes back: one alarm, and the watch is spent
    await ingest(state({ events: [{ id: "w1", kind: "device_offline", at_ms: NOW + 1000, device_id: "aa:bb:cc:00:00:01" }] }, [device({ online: false })]));
    await ingest(state({ timestamp_ms: NOW + 2000, events: [{ id: "w2", kind: "device_online", at_ms: NOW + 2000, device_id: "aa:bb:cc:00:00:01" }] }));
    const alarms = await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie } })).json() as { active: Array<{ code: string; detail?: { ip?: string } }> };
    const watched = alarms.active.filter(alarm => alarm.code === "network_watched_online");
    assert.equal(watched.length, 1);
    assert.equal(watched[0].detail?.ip, "192.168.0.50");
    await ingest(state({ timestamp_ms: NOW + 3000, events: [{ id: "w3", kind: "device_offline", at_ms: NOW + 3000, device_id: "aa:bb:cc:00:00:01" }] }, [device({ online: false })]));
    await ingest(state({ timestamp_ms: NOW + 4000, events: [{ id: "w4", kind: "device_online", at_ms: NOW + 4000, device_id: "aa:bb:cc:00:00:01" }] }));
    const again = await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie } })).json() as { active: Array<{ code: string }> };
    assert.equal(again.active.filter(alarm => alarm.code === "network_watched_online").length, 1, "asked once, told once");
  } finally { await running.stop(); }
});
