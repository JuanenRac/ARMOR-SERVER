// The MQTT door with a real client on a real socket: a tiny in-process broker hands the server a mix of good and hostile messages, and only the good ones reach the state.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import mqttPacket from "mqtt-packet";
import { IngestLog } from "../src/ingest_log.js";
import { attachMqtt } from "../src/mqtt.js";
import { ArmorStore } from "../src/store.js";

type Broker = { port: number; publish: (topic: string, payload: string | Buffer) => void; subscribed: () => string[]; ready: Promise<void>; close: () => Promise<void> };

async function broker(): Promise<Broker> {
  const sockets = new Set<net.Socket>(), topics: string[] = [];
  let done!: () => void;
  const ready = new Promise<void>(resolve => { done = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    parser.on("packet", (packet: { cmd: string; messageId?: number; subscriptions?: Array<{ topic: string }> }) => {
      if (packet.cmd === "connect") socket.write(mqttPacket.generate({ cmd: "connack", returnCode: 0, sessionPresent: false, reasonCode: 0 } as never, { protocolVersion: 5 }));
      if (packet.cmd === "subscribe") {
        for (const item of packet.subscriptions ?? []) topics.push(item.topic);
        socket.write(mqttPacket.generate({ cmd: "suback", messageId: packet.messageId, granted: (packet.subscriptions ?? []).map(() => 1) } as never, { protocolVersion: 5 }));
        done();
      }
      if (packet.cmd === "pingreq") socket.write(mqttPacket.generate({ cmd: "pingresp" } as never, { protocolVersion: 5 }));
    });
    socket.on("data", chunk => parser.parse(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port, ready, subscribed: () => topics,
    publish: (topic, payload) => { for (const socket of sockets) socket.write(mqttPacket.generate({ cmd: "publish", topic, payload, qos: 0, retain: false, dup: false } as never, { protocolVersion: 5 })); },
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

const waitFor = async (condition: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), "timed out waiting"); };
const telemetry = (node: string, extra: Record<string, unknown> = {}) => JSON.stringify({ node_id: node, timestamp_ms: Date.now(), lux: 120, targets: [], ...extra });

test("only well-formed messages of the node that owns the topic change the state; every other kind is counted and kept out", async () => {
  const mqttBroker = await broker();
  const store = new ArmorStore(), log = new IngestLog();
  const warn = console.warn;
  console.warn = () => undefined;
  const client = attachMqtt(store, `mqtt://127.0.0.1:${mqttBroker.port}`, undefined, undefined, log);
  try {
    await mqttBroker.ready;
    assert.deepEqual(mqttBroker.subscribed().sort(), ["armor/node/+/health", "armor/node/+/info", "armor/node/+/telemetry"]);
    const t = "armor/node/north-1/telemetry";
    mqttBroker.publish(t, "{ this is not json");
    mqttBroker.publish(t, "");
    mqttBroker.publish(t, "null");
    mqttBroker.publish(t, "[1,2,3]");
    mqttBroker.publish(t, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    mqttBroker.publish(t, telemetry("north-1", { lux: "bright" }));
    mqttBroker.publish(t, telemetry("north-1", { targets: "many" }));
    mqttBroker.publish(t, JSON.stringify({ timestamp_ms: 5, lux: 1, targets: [] }));
    mqttBroker.publish(t, telemetry("south-2"));                                  // speaks for a neighbour
    mqttBroker.publish("armor/node/north-1/command", telemetry("north-1"));       // not a topic the server listens to as a node
    mqttBroker.publish("armor/server/alert", telemetry("north-1"));
    mqttBroker.publish(t, telemetry("north-1", { lux: 321 }));                    // the only good one
    await waitFor(() => log.list().some(entry => entry.topic === t && entry.accepted === 1));
    const entry = log.list().find(item => item.topic === t)!;
    assert.equal(entry.accepted, 1);
    assert.equal(entry.rejected, 9, "nine messages of the topic were refused, each one counted");
    assert.match(entry.last_error ?? "", /./);
    assert.deepEqual(Object.keys(store.snapshot().nodes), ["north-1"], "the neighbour was not invented");
    assert.equal(store.snapshot().nodes["north-1"].lux, 321);
    assert.equal(log.list().some(item => item.topic.includes("command") || item.topic.includes("server")), false, "foreign topics are not even logged");
  } finally { console.warn = warn; await new Promise<void>(resolve => client.end(true, {}, () => resolve())); await mqttBroker.close(); }
});

test("a newer node that adds a field is still heard: the field is dropped and listed, the rest is used", async () => {
  const mqttBroker = await broker();
  const store = new ArmorStore(), log = new IngestLog();
  const client = attachMqtt(store, `mqtt://127.0.0.1:${mqttBroker.port}`, undefined, undefined, log);
  try {
    await mqttBroker.ready;
    mqttBroker.publish("armor/node/east-3/telemetry", telemetry("east-3", { lux: 77, brand_new_field: { deep: [1] } }));
    await waitFor(() => store.snapshot().nodes["east-3"] !== undefined);
    assert.equal(store.snapshot().nodes["east-3"].lux, 77);
    const entry = log.list().find(item => item.topic === "armor/node/east-3/telemetry")!;
    assert.equal(entry.rejected, 0);
    assert.deepEqual(entry.ignored_fields, ["telemetry.brand_new_field"]);
  } finally { await new Promise<void>(resolve => client.end(true, {}, () => resolve())); await mqttBroker.close(); }
});

test("a node whose clock is not set (it tells the time since start) is stamped with the moment of arrival", async () => {
  const mqttBroker = await broker();
  const store = new ArmorStore(), log = new IngestLog();
  const client = attachMqtt(store, `mqtt://127.0.0.1:${mqttBroker.port}`, undefined, undefined, log);
  try {
    await mqttBroker.ready;
    const before = Date.now();
    mqttBroker.publish("armor/node/west-4/telemetry", JSON.stringify({ node_id: "west-4", timestamp_ms: 4321, lux: 5, targets: [] }));
    await waitFor(() => store.snapshot().nodes["west-4"] !== undefined);
    assert.ok(store.snapshot().nodes["west-4"].timestamp_ms >= before - 1, "stamped with the arrival, not with 4321");
  } finally { await new Promise<void>(resolve => client.end(true, {}, () => resolve())); await mqttBroker.close(); }
});
