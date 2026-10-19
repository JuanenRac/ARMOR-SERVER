/**
 * One table of what the server listens to on the broker: for each kind of message the topics to subscribe to, how the node is named by the topic, how the body is read, and what is done
 * with it. The rule is the same for all of them - the broker's access list lets a node write only its own topics, so a body that names another node is refused - and it lives here once.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { MqttClient } from "mqtt";
import { forwardCompatible } from "./contracts.js";
import type { IngestLog } from "./ingest_log.js";

export type MqttRoute<Message, Named> = {
  /** The filters subscribed to every time the broker connects. */
  subscribe: string[];
  /** Who the topic belongs to, or undefined when the topic is not of this kind. */
  named: (topic: string) => Named | undefined;
  /** Reads and checks the body (it throws when it is not valid). */
  parse: (body: unknown) => Message;
  /** True when the body names the same node (and device) as the topic. */
  matches: (message: Message, named: Named) => boolean;
  /** Does the work. */
  apply: (message: Message, named: Named) => void;
  /** Said when the body is not even an error with a message. */
  fallback: string;
  /** What was wrong when the body names another node; defaults to "node_id does not match the topic". */
  mismatch?: string;
  /** A body that is not a message of this kind but is handled in another way (for example the broker's last will): true when it was dealt with. */
  intercept?: (body: unknown, named: Named, topic: string) => boolean;
};

export type RouteTable = Array<MqttRoute<any, any>>;

export const topicsOf = (routes: RouteTable): string[] => [...new Set(routes.flatMap(route => route.subscribe))];

/** Handles one message: the first route whose topic it is takes it. Returns true when a route took it. */
export function routeMessage(routes: RouteTable, log: IngestLog, rejected: (topic: string, raw: Buffer, error: unknown, fallback: string) => void, topic: string, raw: Buffer): boolean {
  for (const route of routes) {
    const named = route.named(topic);
    if (named === undefined) continue;
    try {
      const body: unknown = JSON.parse(raw.toString("utf8"));
      if (route.intercept?.(body, named, topic)) return true;
      const { value, ignored } = forwardCompatible(() => route.parse(body));
      if (!route.matches(value, named)) throw new Error(route.mismatch ?? "node_id does not match the topic");
      route.apply(value, named);
      log.ok(topic, ignored);
    } catch (error) { rejected(topic, raw, error, route.fallback); }
    return true;
  }
  return false;
}

/** Subscribes to every route's topics on each (re)connection and sends the messages to the table. */
export function attachRoutes(client: MqttClient, routes: RouteTable, log: IngestLog, rejected: (topic: string, raw: Buffer, error: unknown, fallback: string) => void): void {
  client.on("connect", () => client.subscribe(topicsOf(routes), { qos: 1 }));
  client.on("message", (topic, raw) => { routeMessage(routes, log, rejected, topic, raw); });
}
