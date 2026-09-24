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

export function attachMqtt(store: ArmorStore, brokerUrl: string, username?: string, password?: string): MqttClient {
  const client = connect(brokerUrl, { username, password, reconnectPeriod: 2_000, clean: true, protocolVersion: 5 });
  client.on("connect", () => client.subscribe(["armor/node/+/telemetry", "armor/node/+/health"], { qos: 1 }));
  client.on("message", (topic, raw) => {
    try {
      const kind = topicKind(topic);
      if (!kind) return;
      const body: unknown = JSON.parse(raw.toString("utf8"));
      if (kind === "telemetry") store.telemetry(parseTelemetry(body));
      else store.health(parseHealth(body));
    } catch (error) {
      console.warn("ARMOR_MQTT=REJECTED", error instanceof Error ? error.message : "invalid payload");
    }
  });
  return client;
}
