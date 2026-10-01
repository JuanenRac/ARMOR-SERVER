/**
 * The manual orders an operator gives an ARMOR-NETWORK node (a sweep now, a ping, a traceroute, a wake-up, a look at the ports of one device, a look at its web page) and the
 * results the node reports. The orders wait here until the node's next message, in whose answer they are handed out once; the node does them and reports in a following message.
 * Everything is bounded and short-lived: a queue that is not taken within two minutes is forgotten, and only the latest results are kept. Nothing here reaches a device itself:
 * the node does, on its own network, and refuses what is not on it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import { COMMAND_TYPES, type CommandType, type NetworkDevice, type NetworkResult } from "./network.js";

export type NetworkCommand = { id: string; type: CommandType; device_id?: string; ip?: string; mac?: string; port?: number };
export type CommandStatus = "queued" | "sent" | "done" | "expired";
export type CommandRecord = { command: NetworkCommand; node_id: string; by: string; created_at: string; status: CommandStatus; sent_at?: string; result?: NetworkResult };
export class CommandInvalid extends Error { constructor(message: string, readonly code = "invalid_command") { super(message); } }

const MAX_QUEUE_PER_NODE = 16, TAKE_AT_ONCE = 4, WAIT_MS = 120_000, SENT_MS = 180_000, KEEP = 100;
/** The orders that are about one device need it; a sweep is about the whole network. */
const NEEDS_DEVICE: readonly CommandType[] = ["ping", "wake", "ports", "http"];
const PORT_ORDERS: readonly CommandType[] = ["http"];

export class NetworkCommands {
  readonly #records: CommandRecord[] = [];
  readonly #now: () => Date;
  constructor(now: () => Date = () => new Date()) { this.#now = now; }

  /** Queue an order for a node. `device` is what the node last reported about the device the order is for. */
  enqueue(nodeId: string, input: Record<string, unknown>, device: NetworkDevice | undefined, by: string): CommandRecord {
    const type = input.type;
    if (typeof type !== "string" || !(COMMAND_TYPES as readonly string[]).includes(type)) throw new CommandInvalid("unknown order");
    const kind = type as CommandType;
    if (NEEDS_DEVICE.includes(kind) && !device) throw new CommandInvalid("this order is about a device the node knows", "unknown_device");
    if (kind === "wake" && !device?.mac) throw new CommandInvalid("a device with no MAC address cannot be woken", "no_mac");
    this.#expire();
    if (this.#records.filter(record => record.node_id === nodeId && record.status === "queued").length >= MAX_QUEUE_PER_NODE) throw new CommandInvalid("too many orders are waiting for this node", "queue_full");
    const command: NetworkCommand = { id: `c${randomBytes(5).toString("hex")}`, type: kind };
    if (device) { command.device_id = device.id; command.ip = device.ip; if (device.mac) command.mac = device.mac; }
    if (PORT_ORDERS.includes(kind) && input.port !== undefined) {
      if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new CommandInvalid("the port is a number from 1 to 65535");
      command.port = input.port;
    }
    const record: CommandRecord = { command, node_id: nodeId, by: by.slice(0, 60), created_at: this.#now().toISOString(), status: "queued" };
    this.#records.push(record);
    if (this.#records.length > KEEP * 2) this.#records.splice(0, this.#records.length - KEEP * 2);
    return record;
  }

  /** The orders for a node to do now, each handed out once. */
  take(nodeId: string): NetworkCommand[] {
    this.#expire();
    const taken = this.#records.filter(record => record.node_id === nodeId && record.status === "queued").slice(0, TAKE_AT_ONCE);
    const at = this.#now().toISOString();
    for (const record of taken) { record.status = "sent"; record.sent_at = at; }
    return taken.map(record => record.command);
  }

  /** What a node reported. A result for an order that was not given to it (or already answered) is ignored. */
  record(nodeId: string, results: readonly NetworkResult[] | undefined): number {
    let accepted = 0;
    for (const result of results ?? []) {
      const record = this.#records.find(item => item.command.id === result.id && item.node_id === nodeId);
      if (!record || record.status === "done" || record.command.type !== result.type) continue;
      record.status = "done"; record.result = result; accepted += 1;
    }
    return accepted;
  }

  get(id: string): CommandRecord | undefined { this.#expire(); return this.#records.find(record => record.command.id === id); }
  /** The latest orders, newest first. */
  recent(limit = 30): CommandRecord[] { this.#expire(); return this.#records.slice(-limit).reverse(); }

  #expire(): void {
    const now = this.#now().getTime();
    for (const record of this.#records) {
      if (record.status === "queued" && now - Date.parse(record.created_at) > WAIT_MS) record.status = "expired";
      else if (record.status === "sent" && now - Date.parse(record.sent_at ?? record.created_at) > SENT_MS) record.status = "expired";
    }
  }
}
