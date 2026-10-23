/**
 * The Zigbee sensors of an alarm panel's zones, told to the panel. While this server holds the Zigbee radio (Zigbee2MQTT), the panel node does not hear the sensors, so its Zigbee zones
 * would stay at their last state and arming the panel would protect nothing. An administrator links a device of the registry to a zone of a node; every time that device changes, and
 * every `refreshMs` meanwhile (so that a panel that restarts or a lost message heals), the server publishes the zone's state on armor/alarm/{node}/zigbee. The panel takes it only while it
 * does not hold the radio itself (ARMOR-ALARM, docs/FAILOVER.md). It is information towards the panel and never a command: it cannot arm, disarm or sound anything by itself.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { durableRename } from "./durable.js";
import { isTriggered } from "./devices/catalog.js";
import type { Device } from "./devices/registry.js";

export type ZoneLink = { device_id: string; node_id: string; zone_id: string };
export class ZoneLinksInvalid extends Error {}

export const MAX_ZONE_LINKS = 64;
const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/, ZONE = /^[a-z0-9][a-z0-9_-]{0,31}$/, DEVICE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
/** A battery at or below this is reported low (a percent). */
export const LOW_BATTERY = 15;

export function parseZoneLinks(value: unknown): ZoneLink[] {
  if (!Array.isArray(value)) throw new ZoneLinksInvalid("links must be an array");
  if (value.length > MAX_ZONE_LINKS) throw new ZoneLinksInvalid(`at most ${MAX_ZONE_LINKS} links`);
  const seen = new Set<string>(), out: ZoneLink[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null) throw new ZoneLinksInvalid(`link ${index} must be an object`);
    const { device_id, node_id, zone_id, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new ZoneLinksInvalid(`link ${index} has an unknown field`);
    if (typeof device_id !== "string" || !DEVICE.test(device_id)) throw new ZoneLinksInvalid(`link ${index}: invalid device_id`);
    if (typeof node_id !== "string" || !NODE.test(node_id)) throw new ZoneLinksInvalid(`link ${index}: invalid node_id`);
    if (typeof zone_id !== "string" || !ZONE.test(zone_id)) throw new ZoneLinksInvalid(`link ${index}: invalid zone_id`);
    const key = `${node_id}/${zone_id}`;
    if (seen.has(key)) throw new ZoneLinksInvalid(`zone ${key} is linked twice`);
    seen.add(key);
    out.push({ device_id, node_id, zone_id });
  }
  return out;
}

/** What the panel is told: tamper wins over a trigger, a device that is not triggered is normal. */
export function zoneMessage(device: Device, link: ZoneLink): { zone: string; state: "normal" | "triggered" | "tamper"; battery_low: boolean } {
  const state = device.state.tamper === true ? "tamper" : isTriggered(device.kind, device.state) ? "triggered" : "normal";
  const battery = device.state.battery;
  return { zone: link.zone_id, state, battery_low: typeof battery === "number" && battery <= LOW_BATTERY };
}

/**
 * Signs the zone messages so that a panel can tell they came from this server: HMAC-SHA256 over `node|zone|state|battery_low|seq` with a key of the panel, derived from a secret of this
 * server (`zone-feed.key`, 0600). `seq` is the time in milliseconds and only goes up, so a panel that remembers the last one refuses a message that is replayed. The key of a panel is given
 * to the panel by an administrator (GET /api/v1/alarm/zone-feed/key/{node_id}); it never travels on the broker.
 */
export function zoneFeedSignature(keyHex: string, node: string, message: { zone: string; state: string; battery_low: boolean }, seq: number): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(`${node}|${message.zone}|${message.state}|${message.battery_low ? 1 : 0}|${seq}`).digest("hex");
}

export class ZoneFeedSigner {
  #master: Buffer;
  constructor(file: string) {
    let master: Buffer | undefined;
    try { const text = fs.readFileSync(file, "utf8").trim(); if (/^[0-9a-f]{64}$/.test(text)) master = Buffer.from(text, "hex"); } catch { /* the first time */ }
    if (!master) {
      master = randomBytes(32);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, master.toString("hex"), { mode: 0o600 });
      durableRename(temporary, file);
    }
    this.#master = master;
  }

  /** The key of one panel, in hex. */
  keyFor(node: string): string { return createHmac("sha256", this.#master).update(`armor-zone-feed|${node}`).digest("hex"); }

  sign(node: string, message: { zone: string; state: string; battery_low: boolean }, seq: number): string {
    return zoneFeedSignature(this.keyFor(node), node, message, seq);
  }
}

/** What the server tells a panel about the policy it keeps (armor/alarm/{node}/policy): the panel applies the part it understands. */
export type AlarmPolicy = { config_hash: boolean; zone_feed: boolean; zone_feed_signature: boolean;
  /** What the panel asks for to disarm or silence the siren (the setting alarm.disarm_pin). Left out while it is `if_set`, so a panel from before the option reads the same message as ever. */
  disarm_pin?: "never" | "always";
  /** Asks the panel to keep the secrets it stores encrypted in its flash (the setting nodes.nvs_encryption). Left out while it is off. */
  nvs_encryption?: "secrets" };

export class AlarmZoneFeed {
  #links: ZoneLink[] = [];
  #last = 0;

  constructor(private readonly file: string, private readonly options: { publish: (topic: string, payload: string) => void; devices: () => Device[]; refreshMs?: number; now?: () => number; warn?: (message: string) => void;
    /** The setting server.zone_feed: when it is off nothing is sent about the zones (default on). */
    enabled?: () => boolean;
    /** Signs the messages when given (the setting server.zone_feed_signature is on). */
    signer?: () => ZoneFeedSigner | undefined;
    /** The panels to tell the policy to, and the policy (the settings that concern a panel). */
    panels?: () => string[]; policy?: () => AlarmPolicy }) {
    try { this.#links = parseZoneLinks(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { this.#links = []; }
  }

  list(): ZoneLink[] { return this.#links.map(link => ({ ...link })); }

  set(value: unknown): ZoneLink[] {
    const links = parseZoneLinks(value);
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(links, null, 2), { mode: 0o600 });
    durableRename(temporary, this.file);
    this.#links = links;
    this.refresh();
    return this.list();
  }

  /** A device changed (or may have): tell the zones linked to it. A device that does not answer says nothing, so the panel's own silence supervision judges it. */
  handleDevice(device: Device): void {
    for (const link of this.#links) if (link.device_id === device.id) this.#send(device, link);
  }

  /** Every linked zone, from the registry as it is now. */
  refresh(): void {
    const byId = new Map(this.options.devices().map(device => [device.id, device]));
    for (const link of this.#links) { const device = byId.get(link.device_id); if (device) this.#send(device, link); }
  }

  /** Called by the server's periodic sweep: refreshes when `refreshMs` has gone by since the last time. */
  tick(): void {
    const now = (this.options.now ?? Date.now)();
    if (now - this.#last < (this.options.refreshMs ?? 30_000)) return;
    this.#last = now;
    this.refresh();
    this.publishPolicy();
  }

  /** The policy goes to every panel (and again with every refresh, so a panel that restarts learns it). Panels that do not know it ignore the message. */
  publishPolicy(): void {
    if (!this.options.policy || !this.options.panels) return;
    const payload = JSON.stringify(this.options.policy());
    for (const node of new Set([...this.options.panels(), ...this.#links.map(link => link.node_id)])) {
      try { this.options.publish(`armor/alarm/${node}/policy`, payload); }
      catch (error) { this.options.warn?.(`alarm policy: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  #send(device: Device, link: ZoneLink): void {
    if (!device.online || this.options.enabled?.() === false) return;
    try {
      const message = zoneMessage(device, link);
      const signer = this.options.signer?.();
      const seq = (this.options.now ?? Date.now)();
      this.options.publish(`armor/alarm/${link.node_id}/zigbee`, JSON.stringify(signer ? { ...message, seq, sig: signer.sign(link.node_id, message, seq) } : message));
    }
    catch (error) { this.options.warn?.(`zone feed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
