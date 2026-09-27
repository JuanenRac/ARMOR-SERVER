// The state of the local network that the ARMOR-NETWORK nodes report: the parser against the shared vectors, the store (events told once, outages kept), the notes of the
// devices, the alarms, and the routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceNotes, NetworkStore, NoteInvalid, networkTopic, parseNetworkMessage, type NetworkEvent, type NetworkMessage } from "../src/network.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };

test("network parsing agrees with every shared conformance vector", { skip: fs.existsSync(path.join(directory, "network.json")) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const { vectors } = JSON.parse(fs.readFileSync(path.join(directory, "network.json"), "utf8")) as { vectors: Vector[] };
  assert.ok(vectors.length >= 60);
  for (const vector of vectors) {
    if (vector.valid) assert.doesNotThrow(() => parseNetworkMessage(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseNetworkMessage(vector.payload), `should reject: ${vector.name}`);
  }
});

const NOW = 1_790_000_060_000;
const router = { id: "14:2e:5e:86:d9:62", ip: "192.168.0.1", mac: "14:2e:5e:86:d9:62", vendor: "Sercomm", kind: "router" as const, online: true, first_seen_ms: NOW - 1000, last_seen_ms: NOW };
const phone = { id: "96:b3:ed:0b:1c:18", ip: "192.168.0.12", mac: "96:b3:ed:0b:1c:18", randomized_mac: true, kind: "phone" as const, online: true, first_seen_ms: NOW - 1000, last_seen_ms: NOW };
const message = (extra: Partial<NetworkMessage> = {}): NetworkMessage => ({
  kind: "network", node_id: "network-1", timestamp_ms: NOW, interface: { name: "eth0", ip: "192.168.0.10", cidr: "192.168.0.0/24", gateway: "192.168.0.1", rx_bps: 1000, tx_bps: 500 },
  internet: { state: "up", latency_ms: 12 }, devices: [router, phone], events: [], ...extra,
});
const event = (extra: Partial<NetworkEvent>): NetworkEvent => ({ id: "e1", kind: "new_device", at_ms: NOW - 1000, device_id: phone.id, ...extra });

test("the topic names a node and nothing else", () => {
  assert.equal(networkTopic("armor/network/network-1/state"), "network-1");
  for (const topic of ["armor/network/state", "armor/network/network-1/set", "armor/electrical/network-1/state", "armor/network/Node/state", "armor/network/-x/state", "armor/network/a/b/state"]) {
    assert.equal(networkTopic(topic), undefined, topic);
  }
});

test("the rules that join two fields", () => {
  const refused: Record<string, NetworkMessage> = {
    "a device named twice": message({ devices: [router, { ...router }] }),
    "a MAC that is not the id": message({ devices: [{ ...router, id: "aa:bb:cc:dd:ee:ff" }] }),
    "first seen after last seen": message({ devices: [{ ...router, first_seen_ms: NOW + 5 }] }),
    "an event named twice": message({ events: [event({}), event({})] }),
    "an internet event about a device": message({ events: [event({ kind: "internet_down" })] }),
    "a device event with no device": message({ events: [{ id: "e2", kind: "device_offline", at_ms: 1 }] }),
    "a duration on an event that is not an end": message({ events: [event({ id: "e3", outage_s: 4 })] }),
    "a port event with no port": message({ events: [event({ id: "e4", kind: "port_opened" })] }),
  };
  for (const [name, item] of Object.entries(refused)) assert.throws(() => parseNetworkMessage(item), Error, name);
  assert.doesNotThrow(() => parseNetworkMessage(message({ events: [{ id: "e5", kind: "internet_up", at_ms: 1, outage_s: 20 }] })));
  assert.doesNotThrow(() => parseNetworkMessage(message({ devices: [{ id: "ip-192-168-0-9", ip: "192.168.0.9", online: true, first_seen_ms: 1, last_seen_ms: 1 }] })));
  assert.throws(() => parseNetworkMessage({ ...message(), command: "scan" }), /command/);
  assert.throws(() => parseNetworkMessage({ ...message(), interface: { name: "eth0", ip: "192.168.0.10", cidr: "192.168.0.0/24", password: "x" } }), /password/);
});

test("the store tells each event once, keeps the outages and the history, and knows a node that went quiet", () => {
  let clock = NOW;
  const told: string[] = [], stale: string[] = [];
  const dir = tempDir();
  const outagesFile = path.join(dir, "outages.json");
  const store = new NetworkStore({ now: () => clock, sampleEveryMs: 1000, outagesFile, onEvent: (node, item) => told.push(`${node}:${item.id}:${item.kind}`), onStale: (node, isStale) => stale.push(`${node}:${isStale}`) });
  store.ingest(message({ events: [event({ id: "e1", at_ms: NOW - 1000 })] }));
  store.ingest(message({ events: [event({ id: "e1", at_ms: NOW - 1000 })] }));              // the same event repeated in the next message: told once
  assert.deepEqual(told, ["network-1:e1:new_device"]);
  clock += 5000;
  store.ingest(message({ events: [event({ id: "e1" }), { id: "e2", kind: "internet_up", at_ms: clock, outage_s: 45 }] }));
  assert.deepEqual(told.slice(1), ["network-1:e2:internet_up"]);
  assert.equal(store.events().length, 2);
  assert.deepEqual(store.outages().map(o => [o.kind, o.duration_s, o.ended_ms - o.started_ms]), [["internet", 45, 45_000]]);
  assert.equal(new NetworkStore({ outagesFile }).outages().length, 1);                        // kept between runs of the server
  assert.equal(store.history("network-1", 60)!.length, 2);
  assert.equal(store.history("nope", 60), undefined);
  clock += 120_000;
  assert.equal(store.list()[0].stale, true);
  assert.deepEqual(stale, ["network-1:true"]);
  store.ingest(message({ timestamp_ms: clock }));
  assert.deepEqual(stale, ["network-1:true", "network-1:false"]);
  assert.equal(store.remove("network-1"), true);
});

test("the backlog of a node the server has just met is history, not news", () => {
  const told: string[] = [];
  const store = new NetworkStore({ now: () => NOW, onEvent: (_node, item) => told.push(item.id) });
  store.ingest(message({ events: [event({ id: "old", at_ms: NOW - 3_600_000 }), event({ id: "fresh", kind: "device_offline", at_ms: NOW - 5000 })] }));
  assert.deepEqual(told, ["fresh"]);
});

test("the store refuses a new node when it is full, and sums what is there", () => {
  const notes = new DeviceNotes();
  const store = new NetworkStore({ maxNodes: 2, notes });
  store.ingest(message({ node_id: "a" }));
  store.ingest(message({ node_id: "b", internet: { state: "down" }, devices: [router] }));
  assert.throws(() => store.ingest(message({ node_id: "c" })), /too many/);
  notes.set(router.id, { trusted: true });
  assert.deepEqual(store.totals(), { nodes: 2, stale: 0, devices: 3, online: 3, unknown: 1, internet: "down" });   // the worst state of the nodes; the phone is the only one not known
});

test("the notes of a device: what may be said and what is kept", () => {
  const file = path.join(tempDir(), "notes.json");
  const notes = new DeviceNotes(file);
  const saved = notes.set(phone.id, { name: "  Juan's phone ", notes: "the one with the cracked screen", trusted: true, kind: "phone" });
  assert.deepEqual([saved.name, saved.notes, saved.trusted, saved.kind], ["Juan's phone", "the one with the cracked screen", true, "phone"]);
  assert.equal(notes.isTrusted(phone.id), true);
  assert.deepEqual(new DeviceNotes(file).get(phone.id)?.name, "Juan's phone");                  // kept
  assert.equal(notes.set(phone.id, { name: "" }).name, undefined);                              // an empty name removes it, the rest stays
  assert.equal(notes.isTrusted(phone.id), true);
  assert.equal(notes.set(phone.id, { trusted: false }).trusted, undefined);
  for (const bad of [{ name: "x".repeat(49) }, { notes: "x".repeat(301) }, { trusted: "yes" }, { kind: "toaster" }, { unknown: 1 }, "text"]) assert.throws(() => notes.set(phone.id, bad), Error);
  assert.throws(() => notes.set("Bad Id", {}), NoteInvalid);
  assert.equal(notes.remove(phone.id), true);
  assert.equal(notes.remove(phone.id), false);
});

test("the alarms: the internet, a device that is not known, two machines for one address, a port that opened", async () => {
  const { AlarmCentre, AlarmRules } = await import("../src/alarms.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-network-alarms-"));
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");           // none of these depends on the security mode
  const codes = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.severity}:${alarm.source.id}`).sort();
  const known = new Set<string>();
  rules.handleNetwork(message());
  assert.deepEqual(codes(), []);
  rules.handleNetwork(message({ internet: { state: "down" } }));
  assert.deepEqual(codes(), ["network_internet_down:high:network-1"]);
  rules.handleNetwork(message({ internet: { state: "lan_down" } }));
  assert.deepEqual(codes(), ["network_lan_down:high:network-1"]);       // the router is gone too: the local one replaces the provider's
  rules.handleNetwork(message({ internet: { state: "degraded" } }));
  assert.deepEqual(codes(), ["network_degraded:warning:network-1"]);
  rules.handleNetwork(message());
  assert.deepEqual(codes(), []);
  // a device nobody knew
  rules.handleNetworkEvent("network-1", event({}), id => known.has(id));
  assert.deepEqual(codes(), ["network_new_device:warning:network-1/96:b3:ed:0b:1c:18"]);
  rules.handleNetworkTrust(phone.id);
  assert.deepEqual(codes(), []);
  rules.handleNetworkEvent("network-1", event({ id: "e2", device_id: "aa:bb:cc:00:00:01" }), id => id === "aa:bb:cc:00:00:01");     // one the operator already knows
  assert.deepEqual(codes(), []);
  // an impostor for the router
  rules.handleNetworkEvent("network-1", event({ id: "e3", kind: "arp_conflict", device_id: "de:ad:be:ef:01:01" }), () => false);
  assert.deepEqual(codes(), ["network_arp_conflict:high:network-1/de:ad:be:ef:01:01"]);
  rules.handleNetworkEvent("network-1", event({ id: "e4", kind: "device_offline", device_id: "de:ad:be:ef:01:01" }), () => false);
  assert.deepEqual(codes(), []);
  // ports: an ordinary one is a warning, one that a house rarely wants open is high, and closing it ends the alarm
  rules.handleNetworkEvent("network-1", event({ id: "e5", kind: "port_opened", device_id: router.id, port: 8080 }), () => true);
  rules.handleNetworkEvent("network-1", event({ id: "e6", kind: "port_opened", device_id: router.id, port: 23 }), () => true);
  assert.deepEqual(codes(), [`network_port_opened:high:network-1/${router.id}`, `network_port_opened:warning:network-1/${router.id}`]);
  rules.handleNetworkEvent("network-1", event({ id: "e7", kind: "port_closed", device_id: router.id, port: 23 }), () => true);
  assert.deepEqual(codes(), [`network_port_opened:warning:network-1/${router.id}`]);
  // events that are news and not alarms
  rules.handleNetworkEvent("network-1", event({ id: "e8", kind: "device_online", device_id: router.id }), () => true);
  rules.handleNetworkEvent("network-1", { id: "e9", kind: "internet_down", at_ms: 1 }, () => true);
  assert.equal(codes().length, 1);
  rules.handleNetworkStale("network-1", true);
  assert.equal(codes().includes("network_offline:warning:network-1"), true);
  rules.handleNetworkStale("network-1", false);
  assert.equal(codes().includes("network_offline:warning:network-1"), false);
});

test("the routes take a node's state with the ingest token and give it to an operator, with the names an administrator gave", async () => {
  const running = await startServer();
  try {
    const post = (body: unknown, token?: string) => fetch(`${running.base}/api/v1/network/state`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(message())).status, 401);
    assert.equal((await post(message(), "wrong")).status, 401);
    assert.equal((await post({ ...message(), command: "scan" }, SECRETS.ARMOR_INGEST_TOKEN)).status, 400);
    assert.equal((await post({ ...message(), devices: [{ id: "x" }] }, SECRETS.ARMOR_INGEST_TOKEN)).status, 400);
    assert.equal((await post(message({ events: [event({})] }), SECRETS.ARMOR_INGEST_TOKEN)).status, 202);
    assert.equal((await fetch(`${running.base}/api/v1/network`)).status, 401);
    const cookie = await studioCookie(running.base);
    const read = async () => (await (await fetch(`${running.base}/api/v1/network`, { headers: { cookie } })).json()) as {
      nodes: Array<{ node_id: string; stale: boolean; devices: Array<{ id: string; note?: { name?: string; trusted?: boolean } }> }>;
      totals: { devices: number; unknown: number; internet: string }; events: Array<{ kind: string; node_id: string }>; outages: unknown[];
    };
    let seen = await read();
    assert.deepEqual([seen.nodes.length, seen.nodes[0].devices.length, seen.totals.devices, seen.totals.unknown, seen.totals.internet], [1, 2, 2, 2, "up"]);
    assert.deepEqual(seen.events.map(item => [item.kind, item.node_id]), [["new_device", "network-1"]]);
    // an administrator names a device and marks it as known
    const put = (id: string, body: unknown, headers: Record<string, string> = { cookie }) => fetch(`${running.base}/api/v1/network/devices/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await put(phone.id, { name: "Juan's phone" }, {})).status, 401);
    assert.equal((await put(phone.id, { name: "x".repeat(60) })).status, 400);
    assert.equal((await put("Bad Id", { name: "x" })).status, 400);
    assert.equal((await put(phone.id, { name: "Juan's phone", trusted: true })).status, 200);
    seen = await read();
    assert.equal(seen.nodes[0].devices.find(device => device.id === phone.id)?.note?.name, "Juan's phone");
    assert.equal(seen.totals.unknown, 1);
    const alarms = (await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie } })).json()) as { active: Array<{ code: string; cleared_at?: string }> };
    assert.equal(alarms.active.some(alarm => alarm.code === "network_new_device" && !alarm.cleared_at), false);        // marking it as known ended the alarm the event had raised
    assert.equal((await fetch(`${running.base}/api/v1/network/devices/${encodeURIComponent(phone.id)}`, { method: "DELETE", headers: { cookie } })).status, 204);
    assert.equal((await fetch(`${running.base}/api/v1/network/devices/${encodeURIComponent(phone.id)}`, { method: "DELETE", headers: { cookie } })).status, 404);
    // the operator token may look and not name
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    assert.equal((await fetch(`${running.base}/api/v1/network`, { headers: operator })).status, 200);
    assert.equal((await put(phone.id, { name: "x" }, operator)).status, 401);
    // the history
    const history = await fetch(`${running.base}/api/v1/network/history?node=network-1&minutes=30`, { headers: { cookie } });
    assert.equal(history.status, 200);
    assert.equal(((await history.json()) as { samples: unknown[] }).samples.length, 1);
    assert.equal((await fetch(`${running.base}/api/v1/network/history?node=nope`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/network/history?node=Bad`, { headers: { cookie } })).status, 400);
  } finally { await running.stop(); }
});

test("the network design is kept and versioned like the others", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const url = `${running.base}/api/v1/network/design`;
    const get = async () => (await (await fetch(url, { headers: { cookie } })).json()) as { revision: number; network: unknown };
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    assert.deepEqual(await get(), { revision: 0, updated_at: null, updated_by: null, network: null });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await put({ revision: 0, network: { elements: [{ id: "router" }] } })).status, 200);
    assert.equal((await get()).revision, 1);
    const stale = await put({ revision: 0, network: { elements: [] } });
    assert.equal(stale.status, 409);                                                     // a save made from an out-of-date copy is refused
    assert.equal(((await stale.json()) as { current: { revision: number } }).current.revision, 1);
    assert.equal((await put({ revision: 1, network: "text" })).status, 400);
    assert.equal((await put({ revision: 1, network: { big: "x".repeat(787_500) } })).status, 400);
  } finally { await running.stop(); }
});
