/**
 * The Zigbee sensors of an alarm panel's zones, told to the panel. While this server holds the Zigbee radio (Zigbee2MQTT), the panel node does not hear the sensors, so its Zigbee zones
 * would stay at their last state and arming the panel would protect nothing. An administrator links a device of the registry to a zone of a node; every time that device changes, and
 * every `refreshMs` meanwhile (so that a panel that restarts or a lost message heals), the server publishes the zone's state on armor/alarm/{node}/zigbee. The panel takes it only while it
 * does not hold the radio itself (ARMOR-ALARM, docs/FAILOVER.md). It is information towards the panel and never a command: it cannot arm, disarm or sound anything by itself.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
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

export class AlarmZoneFeed {
  #links: ZoneLink[] = [];
  #last = 0;

  constructor(private readonly file: string, private readonly options: { publish: (topic: string, payload: string) => void; devices: () => Device[]; refreshMs?: number; now?: () => number; warn?: (message: string) => void }) {
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
  }

  #send(device: Device, link: ZoneLink): void {
    if (!device.online) return;
    try { this.options.publish(`armor/alarm/${link.node_id}/zigbee`, JSON.stringify(zoneMessage(device, link))); }
    catch (error) { this.options.warn?.(`zone feed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
