/**
 * The alarm centre. An alarm is a condition that needs a person: it is raised when something goes wrong (an intrusion, smoke, a door
 * opened while armed, a camera or a device that stopped answering, a low battery), stays on the list until someone acknowledges it AND
 * its cause has ended, and is kept afterwards as a record. The centre decides nothing on its own about sirens or lights: that is what
 * automations are for. Persisted in the data directory.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { DeviceChange } from "./devices/registry.js";
import { kindInfo, type Severity } from "./devices/catalog.js";
import type { ArmorEvent, ArmorEventBody } from "./events.js";
import type { ElectricalMessage } from "./electrical.js";
import type { NetworkEvent, NetworkMessage } from "./network.js";
import type { SolarMessage } from "./solar.js";
import type { AlarmMessage } from "./alarm.js";
import { ENERGY_ALARM_DEFAULTS, type EnergyAlarmSettings } from "./energy_alarms.js";
import type { SecurityMode } from "./store.js";
import { durableRename } from "./durable.js";

export type AlarmSource = { type: "node" | "camera" | "device" | "solar" | "electrical" | "network" | "alarm"; id: string };
export type Alarm = {
  id: string; key: string; source: AlarmSource; severity: Severity;
  /** What happened, as a stable code the client translates: intrusion, node_down, camera_down, smoke, water_leak, door_open, tamper, low_battery, device_offline ... */
  code: string;
  raised_at: string; acknowledged_at?: string; acknowledged_by?: string; cleared_at?: string;
  /** What a person needs to act on it, as plain facts the client labels: which device (name, address, MAC, maker), which port, what the numbers were. */
  detail?: AlarmDetail;
  /**
   * A silent alarm (a duress disarm) is told only to the places a person standing at the panel cannot see (the webhook, Telegram, ntfy) and is on the list of an
   * administrator only: it is not on the panel's summary, in the event history, on the broker, in a voice answer, in a push to the phones, and nobody but an
   * administrator can acknowledge or delete it.
   */
  silent?: true;
  /**
   * Acknowledged from a place that proves nobody (a wall panel's one tap, a voice command): the alarm leaves the unread list but is NOT taken as dealt with by a person, so a critical
   * one keeps being escalated until somebody who signed in acknowledges it.
   */
  acknowledged_unverified?: true;
};
export type AlarmDetail = Record<string, string | number | boolean>;
const MAX_DETAIL_FIELDS = 24, MAX_DETAIL_VALUE = 200;
/** Only short plain values, a bounded number of them: a node's text is never trusted to be small. */
export const cleanDetail = (detail: Record<string, unknown> | undefined): AlarmDetail | undefined => {
  if (!detail) return undefined;
  const clean: AlarmDetail = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_FIELDS)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === "string") { if (value !== "") clean[key] = value.slice(0, MAX_DETAIL_VALUE); }
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "boolean") clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
};

const MAX_KEPT = 400;
/** The most alarms ever kept: past it even an open one goes, oldest first (a burst of hundreds of alarms is not a list a person reads). */
const HARD_MAX = 2000;
/** Open ports that a house rarely wants open on something anyone on the network can reach: an old remote shell, an unencrypted file transfer, a remote desktop, a database, the provider's remote management. */
const RISKY_PORTS = new Set([21, 23, 445, 3306, 3389, 5432, 5900, 6379, 7547]);
export type AlarmCentreOptions = { file: string; now?: () => Date; onEvent?: (body: ArmorEventBody) => void; onRaised?: (alarm: Alarm) => void; warn?: (message: string) => void };

export class AlarmCentre {
  readonly #options: AlarmCentreOptions;
  readonly #now: () => Date;
  #alarms: Alarm[] = [];
  #counter = 1;
  /** Causes whose alarm somebody took off the list while they were still going on: they stay quiet until the cause ends (clear) and happens again. */
  #muted = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: AlarmCentreOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { alarms?: Alarm[]; counter?: number; muted?: string[] };
      if (Array.isArray(raw.alarms)) this.#alarms = raw.alarms.filter(alarm => typeof alarm?.id === "string" && typeof alarm.key === "string" && typeof alarm.raised_at === "string").slice(-HARD_MAX);
      if (typeof raw.counter === "number") this.#counter = raw.counter;
      if (Array.isArray(raw.muted)) this.#muted = new Set(raw.muted.filter(key => typeof key === "string").slice(-MAX_KEPT));
    } catch { /* nothing kept yet */ }
  }

  #save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.flush(); }, 500);
    this.#timer.unref();
  }

  flush(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    try {
      fs.mkdirSync(path.dirname(this.#options.file), { recursive: true });
      const temporary = `${this.#options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, counter: this.#counter, alarms: this.#alarms, muted: [...this.#muted] }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#options.file);
    } catch (error) { this.#options.warn?.(`the alarms file could not be written: ${(error as Error).message}`); }
  }

  #emit(alarm: Alarm, state: "raised" | "acknowledged" | "cleared"): void {
    this.#options.onEvent?.({ type: "alarm", alarm_id: alarm.id, state, severity: alarm.severity, source: alarm.source.id, source_type: alarm.source.type, code: alarm.code, ...(alarm.silent ? { silent: true as const } : {}) });
  }

  /** The open alarm (its cause has not ended) for a key. */
  #open(key: string): Alarm | undefined { return this.#alarms.find(alarm => alarm.key === key && !alarm.cleared_at); }

  /**
   * Raise an alarm unless one for the same cause is already open. An `instant` alarm is an event, not a condition (somebody disarmed under duress, a watched device came onto the
   * network, a camera saw something): its cause is over the moment it happens, so it is created already ended and leaves the list as soon as somebody acknowledges it.
   */
  raise(key: string, info: { source: AlarmSource; severity: Severity; code: string; detail?: Record<string, unknown>; silent?: boolean; instant?: boolean }): Alarm | undefined {
    // An event (instant) is raised once per key, whatever became of its alarm since; a condition once while it lasts (and not at all while somebody has taken it off the list).
    if (info.instant ? this.#alarms.some(alarm => alarm.key === key) : (this.#open(key) || this.#muted.has(key))) return undefined;
    const detail = cleanDetail(info.detail);
    const raisedAt = this.#now().toISOString();
    const alarm: Alarm = {
      id: `alm-${String(this.#counter).padStart(5, "0")}`, key, source: info.source, severity: info.severity, code: info.code, raised_at: raisedAt,
      ...(info.instant ? { cleared_at: raisedAt } : {}), ...(detail ? { detail } : {}), ...(info.silent ? { silent: true as const } : {}),
    };
    this.#counter += 1;
    this.#alarms.push(alarm);
    this.#trim();
    this.#save();
    this.#emit(alarm, "raised");
    this.#options.onRaised?.(alarm);
    return alarm;
  }

  /**
   * The system was disarmed with the duress PIN: somebody is being forced. A critical alarm that is SILENT (see Alarm.silent): it reaches the people who can help and nothing a
   * person standing at the panel, or holding the phone that disarmed, can see or hear. It is an event, so it is created ended.
   */
  raiseDuress(who: string): Alarm | undefined {
    return this.raise(`duress:${this.#now().getTime()}`, { source: { type: "alarm", id: "duress" }, severity: "critical", code: "duress_disarm", detail: { by: who }, silent: true, instant: true });
  }

  /**
   * Keeps the list to MAX_KEPT by dropping what nobody needs: the oldest alarm that is over and was acknowledged, then the oldest that is over. An alarm that is still going on, or that
   * ended before anybody saw it, is never dropped to make room (a burst of "new device" alarms must not push a critical one off the list); only past HARD_MAX does anything go.
   */
  #trim(): void {
    const drop = (match: (alarm: Alarm) => boolean): boolean => {
      const index = this.#alarms.findIndex(match);
      if (index < 0) return false;
      this.#alarms.splice(index, 1);
      return true;
    };
    while (this.#alarms.length > MAX_KEPT) {
      if (drop(alarm => alarm.cleared_at !== undefined && alarm.acknowledged_at !== undefined)) continue;
      if (drop(alarm => alarm.cleared_at !== undefined)) continue;
      if (this.#alarms.length > HARD_MAX) { this.#alarms.shift(); continue; }
      break;
    }
  }

  /** A cause whose alarm was taken off the list stays quiet until it ends; the memory of that is bounded (the oldest is forgotten first). */
  #mute(key: string): void {
    this.#muted.add(key);
    while (this.#muted.size > MAX_KEPT) this.#muted.delete(this.#muted.values().next().value as string);
  }

  /** The facts of an alarm that is still open, kept up to date while it goes on (the loss and the latency of a slow line, say). */
  update(key: string, detail: Record<string, unknown>): void {
    const alarm = this.#open(key);
    const clean = cleanDetail(detail);
    if (!alarm || !clean) return;
    alarm.detail = { ...alarm.detail, ...clean };
    this.#save();
  }

  /** The cause ended: the alarm stays on the list until it is acknowledged. */
  clear(key: string): void {
    if (this.#muted.delete(key)) this.#save();   // the cause ended: if it happens again it is news again
    const alarm = this.#open(key);
    if (!alarm) return;
    alarm.cleared_at = this.#now().toISOString();
    this.#save();
    this.#emit(alarm, "cleared");
  }

  clearMatching(test: (alarm: Alarm) => boolean): void {
    for (const alarm of this.#alarms) if (!alarm.cleared_at && test(alarm)) this.clear(alarm.key);
  }

  /** A silent alarm is acknowledged only when `silent` is allowed (an administrator's request): for anybody else it is as if it did not exist. */
  acknowledge(id: string, by: string, options: { silent?: boolean; verified?: boolean } = {}): Alarm | undefined {
    const alarm = this.#alarms.find(item => item.id === id);
    if (!alarm || (alarm.silent && options.silent !== true)) return undefined;
    const verified = options.verified !== false;
    if (!alarm.acknowledged_at) {
      alarm.acknowledged_at = this.#now().toISOString(); alarm.acknowledged_by = by.slice(0, 60);
      if (!verified) alarm.acknowledged_unverified = true;
      this.#save();
      this.#emit(alarm, "acknowledged");
    } else if (alarm.acknowledged_unverified && verified) {
      // A person who signed in takes over an acknowledgement nobody vouched for.
      alarm.acknowledged_by = by.slice(0, 60); delete alarm.acknowledged_unverified;
      this.#save();
    }
    return alarm;
  }

  /** Acknowledge the alarms that match (those somebody has not yet), on behalf of `by`. A silent alarm is never acknowledged in bulk. */
  acknowledgeMatching(test: (alarm: Alarm) => boolean, by: string): number {
    let count = 0;
    for (const alarm of this.#alarms) if (!alarm.silent && !alarm.acknowledged_at && test(alarm) && this.acknowledge(alarm.id, by)) count += 1;
    return count;
  }

  /** Every alarm nobody has acknowledged (the silent ones, which only an administrator acknowledges by name, excepted). */
  acknowledgeAll(by: string, options: { verified?: boolean } = {}): number {
    let count = 0;
    for (const alarm of this.#alarms) if (!alarm.silent && !alarm.acknowledged_at && this.acknowledge(alarm.id, by, options)) count += 1;
    return count;
  }

  /**
   * On the list: not yet acknowledged, or still going on. Newest first. The silent alarms are left out unless `silent` is asked for (the list of an administrator): the
   * panel, the summary, the voice and the escalation all read this without it.
   */
  active(options: { silent?: boolean } = {}): Alarm[] { return this.#alarms.filter(alarm => (options.silent === true || !alarm.silent) && (!alarm.acknowledged_at || !alarm.cleared_at)).reverse(); }
  /** Closed (acknowledged and ended): the record. Newest first. */
  recent(limit = 50, options: { silent?: boolean } = {}): Alarm[] { return this.#alarms.filter(alarm => (options.silent === true || !alarm.silent) && alarm.acknowledged_at && alarm.cleared_at).reverse().slice(0, limit); }
  /**
   * Take one alarm off the list altogether (open or closed). If its cause is still going on it simply is not on the list any more: the
   * alarm for the same cause is raised again only when the cause happens again (a port that opens anew, the line going bad anew).
   */
  remove(id: string, options: { silent?: boolean } = {}): Alarm | undefined {
    const index = this.#alarms.findIndex(alarm => alarm.id === id && (!alarm.silent || options.silent === true));
    if (index < 0) return undefined;
    const [alarm] = this.#alarms.splice(index, 1);
    // The cause is still going on (nobody cleared it): the same condition reported again must not bring the alarm back.
    if (!alarm.cleared_at) this.#mute(alarm.key);
    this.#save();
    return alarm;
  }

  /** Delete every alarm someone has acknowledged, whether its cause has ended or not (the record, and what was seen and is being lived with). The ones nobody has seen stay. */
  clearAcknowledged(options: { silent?: boolean } = {}): number {
    const before = this.#alarms.length;
    const goes = (alarm: Alarm) => alarm.acknowledged_at !== undefined && (!alarm.silent || options.silent === true);
    for (const alarm of this.#alarms) if (goes(alarm) && !alarm.cleared_at) this.#mute(alarm.key);
    this.#alarms = this.#alarms.filter(alarm => !goes(alarm));
    this.#save();
    return before - this.#alarms.length;
  }

  /** Delete the closed alarms (an administrator clearing the record). */
  deleteRecent(options: { silent?: boolean } = {}): number {
    const before = this.#alarms.length;
    this.#alarms = this.#alarms.filter(alarm => !(alarm.acknowledged_at && alarm.cleared_at && (!alarm.silent || options.silent === true)));
    this.#save();
    return before - this.#alarms.length;
  }
}

const armedOnlyCodes = new Set(["intrusion", "door_open", "window_open", "motion", "glass_break", "vibration"]);
const DEVICE_CODE: Record<string, string> = { smoke: "smoke", co: "co", gas: "gas", water_leak: "water_leak", panic_button: "panic", door: "door_open", window: "window_open", motion: "motion", glass_break: "glass_break", vibration: "vibration" };
/** How long a slow or lossy line has to stay so before it is worth an alarm. */
export const NETWORK_DEGRADED_DWELL_MS = 3 * 60_000;
const LOW_BATTERY = 15, BATTERY_OK = 20;
/** The mains voltage an AC channel of an electrical node may have (about 230 V less 15 % and plus 10 %), with the margin at which a raised alarm ends; below GRID_LOST the channel has no supply at all. */
const MAINS_LOW = 195, MAINS_LOW_OK = 200, MAINS_HIGH = 253, MAINS_HIGH_OK = 250, GRID_LOST = 50, GRID_BACK = 100;
/** The QPIWS flags that mean the inverter is faulty, not just warning. */
export const SOLAR_FAULTS = new Set(["inverter_fault", "bus_over", "bus_under", "bus_soft_fail", "inverter_voltage_low", "inverter_voltage_high", "over_temperature", "fan_locked",
  "eeprom_fault", "inverter_over_current", "inverter_soft_fail", "self_test_fail", "op_dc_voltage_over", "battery_open", "current_sensor_fail", "battery_short"]);

/**
 * What raises and clears alarms: the rules that connect the events of the perimeter (a node, a camera, the mode) and the reports of the
 * devices to the alarm centre.
 */
export class AlarmRules {
  constructor(private readonly centre: AlarmCentre, private readonly mode: () => SecurityMode, private readonly energy: () => EnergyAlarmSettings = () => ENERGY_ALARM_DEFAULTS) {}

  /**
   * What is already wrong when the system is armed: a node that fell silent, a camera that stopped answering or a door left open while it was disarmed raised nothing then (they matter
   * only while armed), and the changes that would raise them have already happened. Set by the context, which knows the nodes, the cameras and the devices.
   */
  onArmed: (() => void) | undefined;

  /** A problem that was there before arming, now that it matters. */
  raisePresentProblems(problems: { nodesDown: string[]; camerasDown: string[]; devicesTriggered: Array<{ id: string; kind: string }> }): void {
    for (const id of problems.nodesDown) this.centre.raise(`node:${id}:down`, { source: { type: "node", id }, severity: "warning", code: "node_down" });
    for (const id of problems.camerasDown) this.centre.raise(`camera:${id}:down`, { source: { type: "camera", id }, severity: "warning", code: "camera_down" });
    for (const device of problems.devicesTriggered) {
      const info = kindInfo(device.kind as never);
      if (info.alarm === "armed") this.centre.raise(`device:${device.id}:trigger`, { source: { type: "device", id: device.id }, severity: info.severity, code: DEVICE_CODE[device.kind] ?? "triggered" });
    }
  }

  /** Node, camera and mode events. */
  handleEvent(event: ArmorEvent | ArmorEventBody): void {
    switch (event.type) {
      case "alert":
        if (event.to === "high") this.centre.raise(`node:${event.node_id}:intrusion`, { source: { type: "node", id: event.node_id }, severity: "high", code: "intrusion" });
        else if (event.from === "high") this.centre.clear(`node:${event.node_id}:intrusion`);
        break;
      case "node":
        if (event.to === "online") this.centre.clear(`node:${event.node_id}:down`);
        else if (this.mode() === "armed") this.centre.raise(`node:${event.node_id}:down`, { source: { type: "node", id: event.node_id }, severity: "warning", code: "node_down" });
        break;
      case "camera":
        if (event.to === "online") this.centre.clear(`camera:${event.camera_id}:down`);
        else if (event.to === "offline" && this.mode() === "armed") this.centre.raise(`camera:${event.camera_id}:down`, { source: { type: "camera", id: event.camera_id }, severity: "warning", code: "camera_down" });
        break;
      case "mode":
        if (event.mode === "armed") this.onArmed?.();
        // Disarming ends every intrusion alarm: nothing is being defended any more.
        if (event.mode === "disarmed") {
          const ends = (alarm: Alarm) => armedOnlyCodes.has(alarm.code) || alarm.code === "node_down" || alarm.code === "camera_down";
          this.centre.clearMatching(ends);
          // Whoever disarms has dealt with them: they do not wait for a second click to leave the list (they go to the record, with "disarm" as who).
          this.centre.acknowledgeMatching(ends, "disarm");
        }
        break;
      default: break;
    }
  }

  /** A device reported. */
  handleDevice(change: DeviceChange): void {
    const { device } = change, info = kindInfo(device.kind), source: AlarmSource = { type: "device", id: device.id };
    const base = `device:${device.id}`;
    if (change.triggered !== undefined && info.alarm !== "none") {
      const key = `${base}:trigger`;
      if (change.triggered) {
        if (info.alarm === "always" || this.mode() === "armed") this.centre.raise(key, { source, severity: info.severity, code: DEVICE_CODE[device.kind] ?? "triggered" });
      } else this.centre.clear(key);
    }
    if (change.changes.some(item => item.field === "tamper")) {
      if (device.state.tamper === true) this.centre.raise(`${base}:tamper`, { source, severity: "warning", code: "tamper" });
      else this.centre.clear(`${base}:tamper`);
    }
    const battery = device.state.battery;
    if (typeof battery === "number") {
      if (battery < LOW_BATTERY) this.centre.raise(`${base}:battery`, { source, severity: "warning", code: "low_battery" });
      else if (battery >= BATTERY_OK) this.centre.clear(`${base}:battery`);
    }
    if (change.onlineChanged) {
      if (!device.online && device.expected_interval_s > 0) this.centre.raise(`${base}:offline`, { source, severity: "warning", code: "device_offline" });
      else if (device.online) this.centre.clear(`${base}:offline`);
    }
  }

  /**
   * A solar reading. A fault of an inverter (its mode, or a warning that is a fault) is high; a low battery (or a battery stack that reports an
   * alarm) is a warning that ends when the charge is back above the recovery level. None of these depends on the security mode.
   */
  handleSolar(message: SolarMessage): void {
    const id = `${message.node_id}/${message.device}`, source: AlarmSource = { type: "solar", id };
    const base = `solar:${id}`;
    // Speaking at all ends the silence, whether or not the store saw it begin (after a restart it did not): an "offline" alarm raised before the restart would stay for ever.
    this.centre.clear(`${base}:offline`);
    const level = this.energy();
    if (message.kind === "inverter") {
      const fault = message.mode === "fault" || message.warnings.some(name => SOLAR_FAULTS.has(name));
      if (fault) this.centre.raise(`${base}:fault`, { source, severity: "high", code: "solar_fault" });
      else this.centre.clear(`${base}:fault`);
      const low = message.battery_percent < level.soc_low || message.warnings.includes("battery_low") || message.warnings.includes("battery_under_shutdown");
      if (low) this.centre.raise(`${base}:battery`, { source, severity: "warning", code: "solar_battery_low" });
      else if (message.battery_percent >= level.soc_ok) this.centre.clear(`${base}:battery`);
      if (message.heatsink_c >= level.heatsink_high_c) this.centre.raise(`${base}:hot`, { source, severity: "warning", code: "solar_inverter_hot" });
      else if (message.heatsink_c < level.heatsink_high_c - 5) this.centre.clear(`${base}:hot`);
    } else if (message.modules > 0) {
      if (message.alarm === true) this.centre.raise(`${base}:battery_alarm`, { source, severity: "high", code: "solar_battery_alarm" });
      else this.centre.clear(`${base}:battery_alarm`);
      const soc = message.soc_percent;
      if (soc !== undefined && soc < level.soc_low) this.centre.raise(`${base}:battery`, { source, severity: "warning", code: "solar_battery_low" });
      else if (soc !== undefined && soc >= level.soc_ok) this.centre.clear(`${base}:battery`);
      // the cells of the stack, the temperature and the wear: warnings that end with a margin, so a value on the edge does not flap
      if (message.cell_min_v !== undefined && message.cell_max_v !== undefined) {
        const spreadMv = (message.cell_max_v - message.cell_min_v) * 1000;
        if (spreadMv > level.cell_spread_mv) this.centre.raise(`${base}:cells`, { source, severity: "warning", code: "solar_cells_unbalanced" });
        else if (spreadMv < level.cell_spread_mv * 0.8) this.centre.clear(`${base}:cells`);
      }
      if (message.temperature_max_c !== undefined) {
        if (message.temperature_max_c >= level.battery_temp_high_c) this.centre.raise(`${base}:hot`, { source, severity: "warning", code: "solar_battery_hot" });
        else if (message.temperature_max_c < level.battery_temp_high_c - 3) this.centre.clear(`${base}:hot`);
      }
      if (message.temperature_min_c !== undefined) {
        if (message.state === "charging" && message.temperature_min_c < level.battery_temp_low_c) this.centre.raise(`${base}:cold`, { source, severity: "warning", code: "solar_battery_cold" });
        else if (message.state !== "charging" || message.temperature_min_c >= level.battery_temp_low_c + 2) this.centre.clear(`${base}:cold`);
      }
      if (message.health_percent !== undefined) {
        if (message.health_percent < level.health_low_percent) this.centre.raise(`${base}:worn`, { source, severity: "warning", code: "solar_battery_worn" });
        else if (message.health_percent >= level.health_low_percent + 5) this.centre.clear(`${base}:worn`);
      }
    }
  }

  /** A solar device went silent, or came back. */
  handleSolarStale(node: string, device: string, stale: boolean): void {
    const id = `${node}/${device}`;
    if (stale) this.centre.raise(`solar:${id}:offline`, { source: { type: "solar", id }, severity: "warning", code: "solar_offline" });
    else this.centre.clear(`solar:${id}:offline`);
  }

  /**
   * An electrical node's reading. A meter's own alarm flag, an AC channel whose voltage is out of the range of the mains, and the grid input being lost are warnings that end
   * when the cause does (the voltage with a margin, so a value on the edge does not flap). None of these depends on the security mode. A channel that is not in the message
   * says nothing, so what it had raised stays until the node is forgotten or the channel speaks again.
   */
  handleElectrical(message: ElectricalMessage): void {
    this.centre.clear(`electrical:${message.node_id}:offline`);   // it speaks: the silence is over (see handleSolar)
    this.handleElectricalSwitches(message);
    for (const channel of message.channels) {
      const id = `${message.node_id}/${channel.id}`, source: AlarmSource = { type: "electrical", id };
      const base = `electrical:${id}`;
      if (channel.alarm === true) this.centre.raise(`${base}:alarm`, { source, severity: "warning", code: "electrical_alarm" });
      else if (channel.alarm === false) this.centre.clear(`${base}:alarm`);
      if (channel.domain !== "ac" || channel.voltage_v === undefined) continue;
      const volts = channel.voltage_v;
      if (channel.id === "grid") {
        if (volts < GRID_LOST) this.centre.raise(`${base}:lost`, { source, severity: "warning", code: "electrical_grid_lost" });
        else if (volts >= GRID_BACK) this.centre.clear(`${base}:lost`);
      }
      // below GRID_BACK there is no mains to speak of (a circuit that is off, or the grid lost, which is its own alarm): "out of range" is for a supply that is there
      if (volts < GRID_BACK) this.centre.clear(`${base}:voltage`);
      else if (volts < MAINS_LOW || volts > MAINS_HIGH) this.centre.raise(`${base}:voltage`, { source, severity: "warning", code: "electrical_voltage" });
      else if (volts >= MAINS_LOW_OK && volts <= MAINS_HIGH_OK) this.centre.clear(`${base}:voltage`);
    }
  }

  /**
   * The state of an ARMOR-ALARM node's panel. A sounding alarm is CRITICAL and lasts as long as the node says it is in the alarm phase (it latches until a correct disarm; a siren silenced with the PIN, or one that timed out, changes nothing here: the alarm stays open and unacknowledged, because nobody has looked at its cause); a
   * zone in tamper is a high alarm that ends with the tamper; a panel locked out after wrong PINs is a warning. These come from the node's own panel and do not depend on the
   * security mode of this server: the node decides whether it is armed. A node that goes quiet while it was armed or counting down is a warning.
   */
  handleAlarmNode(message: AlarmMessage, _previous: AlarmMessage | undefined): void {
    const base = `alarm:${message.node_id}`, source: AlarmSource = { type: "alarm", id: message.node_id };
    this.centre.clear(`${base}:offline`);   // it speaks: the silence is over (see handleSolar)
    const zone = message.events.filter(event => event.kind === "alarm" && event.zone !== undefined).at(-1)?.zone;
    if (message.phase === "alarm") this.centre.raise(`${base}:sounding`, { source, severity: "critical", code: "alarm_sounding", detail: { node: message.node_id, mode: message.mode, siren: message.siren, ...(zone ? { zone } : {}) } });
    else this.centre.clear(`${base}:sounding`);
    for (const item of message.zones) {
      const key = `${base}:${item.id}:tamper`;
      if (item.state === "tamper") this.centre.raise(key, { source: { type: "alarm", id: `${message.node_id}/${item.id}` }, severity: "high", code: "alarm_tamper", detail: { node: message.node_id, zone: item.id } });
      else this.centre.clear(key);
      // a zone the node cannot read is not guarding: a warning that lasts as long as the trouble (it never sounds the siren, and the node will not arm with it unless it is left out)
      const troubleKey = `${base}:${item.id}:trouble`;
      if (item.state === "trouble") this.centre.raise(troubleKey, { source: { type: "alarm", id: `${message.node_id}/${item.id}` }, severity: "warning", code: "alarm_zone_trouble", detail: { node: message.node_id, zone: item.id } });
      else this.centre.clear(troubleKey);
    }
    if (message.locked_out) this.centre.raise(`${base}:locked_out`, { source, severity: "warning", code: "alarm_locked_out", detail: { node: message.node_id } });
    else this.centre.clear(`${base}:locked_out`);
  }

  /** An alarm node went silent, or came back. Silence matters only while the panel was guarding, which the alarm raised before it fell silent says. */
  handleAlarmNodeStale(node: string, stale: boolean, phase?: string): void {
    if (stale && phase === "disarmed") return;   // a disarmed panel that goes quiet: it was not guarding, so there is nothing to wake anybody for (it is back-to-normal when it speaks again)
    if (stale) this.centre.raise(`alarm:${node}:offline`, { source: { type: "alarm", id: node }, severity: "warning", code: "alarm_offline" });
    else this.centre.clear(`alarm:${node}:offline`);
  }

  /**
   * The switches of an electrical node. A latched fault (a contactor that did not close, one that did not open, both closed) is a HIGH alarm that ends when the node says the
   * fault is gone; both contacts closed at once is one whatever the node says about its own fault. An armed or closing switch is not an alarm: it is what was asked.
   */
  handleElectricalSwitches(message: ElectricalMessage): void {
    for (const item of message.switches ?? []) {
      const id = `${message.node_id}/${item.id}`, key = `electrical:${id}:switch`;
      if (item.fault !== "none" || (item.a_closed && item.b_closed)) this.centre.raise(key, { source: { type: "electrical", id }, severity: "high", code: "electrical_switch_fault" });
      else this.centre.clear(key);
    }
  }

  /**
   * The state of the network an ARMOR-NETWORK node watches: the internet is down (the router answers and nothing beyond it does: the provider's side), the local network is down
   * (the router does not answer either), or the internet is degraded. They end when the node says they have. None depends on the security mode.
   */
  handleNetwork(message: NetworkMessage): void {
    const base = `network:${message.node_id}`, source: AlarmSource = { type: "network", id: message.node_id };
    this.centre.clear(`${base}:offline`);   // it speaks: the silence is over (see handleSolar)
    const state = message.internet.state;
    const facts = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      node: message.node_id, interface: message.interface.name, router: message.interface.gateway ?? "",
      ...(message.internet.latency_ms !== undefined ? { latency_ms: message.internet.latency_ms } : {}),
      ...(message.internet.loss_percent !== undefined ? { loss_percent: message.internet.loss_percent } : {}),
      ...(message.internet.since_ms !== undefined ? { since: new Date(message.internet.since_ms).toISOString() } : {}),
      failing: (message.internet.probes ?? []).filter(probe => !probe.ok).map(probe => `${probe.kind} ${probe.target}`).join(", "),
      ...extra,
    });
    if (state === "down") this.centre.raise(`${base}:internet`, { source, severity: "high", code: "network_internet_down", detail: facts({ router_answers: message.internet.gateway_ok ?? "" }) }); else this.centre.clear(`${base}:internet`);
    if (state === "lan_down") this.centre.raise(`${base}:lan`, { source, severity: "high", code: "network_lan_down", detail: facts() }); else this.centre.clear(`${base}:lan`);
    // A line that is slow or loses packets for a moment is not news: the warning is raised once it has gone on for NETWORK_DEGRADED_DWELL_MS, and kept up to date while it lasts.
    if (state === "degraded") {
      const since = message.internet.since_ms ?? message.timestamp_ms;
      if (message.timestamp_ms - since >= NETWORK_DEGRADED_DWELL_MS) this.centre.raise(`${base}:degraded`, { source, severity: "warning", code: "network_degraded", detail: facts() });
      else this.centre.update(`${base}:degraded`, facts());
    } else this.centre.clear(`${base}:degraded`);
  }

  /**
   * An event of the network. A device that was never seen (unless the operator already marked it as known), an address answered by another MAC (a machine that took the router's
   * place, or a mistake), and a port that opened (a high alarm when it is one a house rarely wants open, such as Telnet or a remote desktop) raise an alarm; a port that closed
   * or a device that went away ends the one about it. Being offline or online again is news for the list of events, not an alarm.
   */
  handleNetworkEvent(node: string, event: NetworkEvent, isKnown: (deviceId: string) => boolean, describe: (deviceId: string) => Record<string, unknown> = () => ({})): void {
    if (!event.device_id) return;
    const id = `${node}/${event.device_id}`, source: AlarmSource = { type: "network", id }, base = `network:${id}`;
    const facts = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ node, ...describe(event.device_id!), ...extra });
    const conflict = /answered by ([0-9a-f:]{17}); before by ([0-9a-f:]{17})/i.exec(event.detail ?? "");
    if (event.kind === "new_device" && !isKnown(event.device_id)) this.centre.raise(`${base}:new`, { source, severity: "warning", code: "network_new_device", detail: facts({ first_seen: new Date(event.at_ms).toISOString() }) });
    else if (event.kind === "arp_conflict") this.centre.raise(`${base}:arp`, { source, severity: "high", code: "network_arp_conflict", detail: facts(conflict ? { mac_now: conflict[1].toLowerCase(), mac_before: conflict[2].toLowerCase() } : { what_happened: event.detail ?? "" }) });
    else if (event.kind === "port_opened" && event.port !== undefined) this.centre.raise(`${base}:port:${event.port}`, { source, severity: RISKY_PORTS.has(event.port) ? "high" : "warning", code: "network_port_opened", detail: facts({ port: event.port, risky: RISKY_PORTS.has(event.port), opened_at: new Date(event.at_ms).toISOString() }) });
    else if (event.kind === "port_closed" && event.port !== undefined) this.centre.clear(`${base}:port:${event.port}`);
    else if (event.kind === "device_offline") this.centre.clear(`${base}:arp`);
  }

  /** A device an operator asked to be told about came onto the network. */
  handleNetworkWatched(node: string, event: NetworkEvent, describe: (deviceId: string) => Record<string, unknown>): void {
    if (!event.device_id) return;
    const id = `${node}/${event.device_id}`;
    this.centre.raise(`network:${id}:watch:${event.id}`, { source: { type: "network", id }, severity: "warning", code: "network_watched_online", detail: { node, ...describe(event.device_id), came_at: new Date(event.at_ms).toISOString() }, instant: true });
  }

  /** An operator marked a device as known: its "new device" alarm has no reason left. */
  handleNetworkTrust(deviceId: string): void { this.centre.clearMatching(alarm => alarm.code === "network_new_device" && alarm.source.type === "network" && alarm.source.id.endsWith(`/${deviceId}`)); }

  /** An ARMOR-NETWORK node went silent, or came back. */
  handleNetworkStale(node: string, stale: boolean): void {
    if (stale) this.centre.raise(`network:${node}:offline`, { source: { type: "network", id: node }, severity: "warning", code: "network_offline" });
    else this.centre.clear(`network:${node}:offline`);
  }

  /** An electrical node went silent, or came back. */
  handleElectricalStale(node: string, stale: boolean): void {
    if (stale) this.centre.raise(`electrical:${node}:offline`, { source: { type: "electrical", id: node }, severity: "warning", code: "electrical_offline" });
    else this.centre.clear(`electrical:${node}:offline`);
  }

  /** A camera answered: whatever kept it from answering before is over (after a restart the watcher does not say that it came back). */
  cameraAnswered(id: string): void { this.centre.clear(`camera:${id}:down`); }

  /** A field node was taken away on purpose: its silence is not news any more. */
  forgetNode(id: string): void { for (const kind of ["electrical", "alarm", "network"]) this.centre.clear(`${kind}:${id}:offline`); }

  /** A device that was removed can no longer be in trouble. */
  forgetDevice(id: string): void { this.centre.clearMatching(alarm => alarm.source.type === "device" && alarm.source.id === id); }
}
