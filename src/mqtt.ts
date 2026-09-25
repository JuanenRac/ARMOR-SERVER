/**
 * A.R.M.O.R. MQTT ingress adapter.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { connect, type MqttClient } from "mqtt";
import { parseHealth, parseTelemetry } from "./contracts.js";
import { ArmorStore } from "./store.js";

export function topicKind(topic: string): "telemetry" | "health" | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "node" || !parts[2]) return undefined;
  return parts[3] === "telemetry" || parts[3] === "health" ? parts[3] : undefined;
}

/** The node a topic belongs to (armor/node/<id>/...), or undefined. */
export function topicNode(topic: string): string | undefined {
  const parts = topic.split("/");
  return parts.length === 4 && parts[0] === "armor" && parts[1] === "node" && parts[2] ? parts[2] : undefined;
}

/**
 * The broker's ACL lets a node write only its own topics, so the identity in the
 * topic is the one that was authenticated. A message whose body claims another
 * node would let one compromised node impersonate a neighbour: refuse it.
 */
export function bodyMatchesTopic(topic: string, body: { node_id: string }): boolean {
  return topicNode(topic) === body.node_id;
}

export function attachMqtt(store: ArmorStore, brokerUrl: string, username?: string, password?: string): MqttClient {
  const client = connect(brokerUrl, { username, password, reconnectPeriod: 2_000, clean: true, protocolVersion: 5 });
  client.on("connect", () => client.subscribe(["armor/node/+/telemetry", "armor/node/+/health"], { qos: 1 }));
  client.on("message", (topic, raw) => {
    try {
      const kind = topicKind(topic);
      if (!kind) return;
      const body: unknown = JSON.parse(raw.toString("utf8"));
      const message = kind === "telemetry" ? parseTelemetry(body) : parseHealth(body);
      if (!bodyMatchesTopic(topic, message)) throw new Error("node_id does not match the topic");
      if (kind === "telemetry") store.telemetry(message as ReturnType<typeof parseTelemetry>);
      else store.health(message as ReturnType<typeof parseHealth>);
    } catch (error) {
      console.warn("ARMOR_MQTT=REJECTED", error instanceof Error ? error.message : "invalid payload");
    }
  });
  return client;
}
