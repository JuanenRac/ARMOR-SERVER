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
import type { SolarMessage } from "./solar.js";
import type { SecurityMode } from "./store.js";

export type AlarmSource = { type: "node" | "camera" | "device" | "solar" | "electrical"; id: string };
export type Alarm = {
  id: string; key: string; source: AlarmSource; severity: Severity;
  /** What happened, as a stable code the client translates: intrusion, node_down, camera_down, smoke, water_leak, door_open, tamper, low_battery, device_offline ... */
  code: string;
  raised_at: string; acknowledged_at?: string; acknowledged_by?: string; cleared_at?: string;
};

const MAX_KEPT = 400;
export type AlarmCentreOptions = { file: string; now?: () => Date; onEvent?: (body: ArmorEventBody) => void; onRaised?: (alarm: Alarm) => void; warn?: (message: string) => void };

export class AlarmCentre {
  readonly #options: AlarmCentreOptions;
  readonly #now: () => Date;
  #alarms: Alarm[] = [];
  #counter = 1;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: AlarmCentreOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { alarms?: Alarm[]; counter?: number };
      if (Array.isArray(raw.alarms)) this.#alarms = raw.alarms.filter(alarm => typeof alarm?.id === "string" && typeof alarm.key === "string" && typeof alarm.raised_at === "string").slice(-MAX_KEPT);
      if (typeof raw.counter === "number") this.#counter = raw.counter;
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
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, counter: this.#counter, alarms: this.#alarms }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.#options.file);
    } catch (error) { this.#options.warn?.(`the alarms file could not be written: ${(error as Error).message}`); }
  }

  #emit(alarm: Alarm, state: "raised" | "acknowledged" | "cleared"): void {
    this.#options.onEvent?.({ type: "alarm", alarm_id: alarm.id, state, severity: alarm.severity, source: alarm.source.id, source_type: alarm.source.type, code: alarm.code });
  }

  /** The open alarm (its cause has not ended) for a key. */
  #open(key: string): Alarm | undefined { return this.#alarms.find(alarm => alarm.key === key && !alarm.cleared_at); }

  /** Raise an alarm unless one for the same cause is already open. */
  raise(key: string, info: { source: AlarmSource; severity: Severity; code: string }): Alarm | undefined {
    if (this.#open(key)) return undefined;
    const alarm: Alarm = { id: `alm-${String(this.#counter).padStart(5, "0")}`, key, source: info.source, severity: info.severity, code: info.code, raised_at: this.#now().toISOString() };
    this.#counter += 1;
    this.#alarms.push(alarm);
    if (this.#alarms.length > MAX_KEPT) this.#alarms.splice(0, this.#alarms.length - MAX_KEPT);
    this.#save();
    this.#emit(alarm, "raised");
    this.#options.onRaised?.(alarm);
    return alarm;
  }

  /** The cause ended: the alarm stays on the list until it is acknowledged. */
  clear(key: string): void {
    const alarm = this.#open(key);
    if (!alarm) return;
    alarm.cleared_at = this.#now().toISOString();
    this.#save();
    this.#emit(alarm, "cleared");
  }

  clearMatching(test: (alarm: Alarm) => boolean): void {
    for (const alarm of this.#alarms) if (!alarm.cleared_at && test(alarm)) this.clear(alarm.key);
  }

  acknowledge(id: string, by: string): Alarm | undefined {
    const alarm = this.#alarms.find(item => item.id === id);
    if (!alarm) return undefined;
    if (!alarm.acknowledged_at) {
      alarm.acknowledged_at = this.#now().toISOString(); alarm.acknowledged_by = by.slice(0, 60);
      this.#save();
      this.#emit(alarm, "acknowledged");
    }
    return alarm;
  }

  acknowledgeAll(by: string): number {
    let count = 0;
    for (const alarm of this.#alarms) if (!alarm.acknowledged_at && this.acknowledge(alarm.id, by)) count += 1;
    return count;
  }

  /** On the list: not yet acknowledged, or still going on. Newest first. */
  active(): Alarm[] { return this.#alarms.filter(alarm => !alarm.acknowledged_at || !alarm.cleared_at).reverse(); }
  /** Closed (acknowledged and ended): the record. Newest first. */
  recent(limit = 50): Alarm[] { return this.#alarms.filter(alarm => alarm.acknowledged_at && alarm.cleared_at).reverse().slice(0, limit); }
  /** Delete the closed alarms (an administrator clearing the record). */
  deleteRecent(): number {
    const before = this.#alarms.length;
    this.#alarms = this.#alarms.filter(alarm => !(alarm.acknowledged_at && alarm.cleared_at));
    this.#save();
    return before - this.#alarms.length;
  }
}

const armedOnlyCodes = new Set(["intrusion", "door_open", "window_open", "motion", "glass_break", "vibration"]);
const DEVICE_CODE: Record<string, string> = { smoke: "smoke", co: "co", gas: "gas", water_leak: "water_leak", panic_button: "panic", door: "door_open", window: "window_open", motion: "motion", glass_break: "glass_break", vibration: "vibration" };
const LOW_BATTERY = 15, BATTERY_OK = 20;
const SOLAR_LOW = 20, SOLAR_OK = 30;
/** The mains voltage an AC channel of an electrical node may have (about 230 V less 15 % and plus 10 %), with the margin at which a raised alarm ends; below GRID_LOST the channel has no supply at all. */
const MAINS_LOW = 195, MAINS_LOW_OK = 200, MAINS_HIGH = 253, MAINS_HIGH_OK = 250, GRID_LOST = 50, GRID_BACK = 100;
/** The QPIWS flags that mean the inverter is faulty, not just warning. */
const SOLAR_FAULTS = new Set(["inverter_fault", "bus_over", "bus_under", "bus_soft_fail", "inverter_voltage_low", "inverter_voltage_high", "over_temperature", "fan_locked",
  "eeprom_fault", "inverter_over_current", "inverter_soft_fail", "self_test_fail", "op_dc_voltage_over", "battery_open", "current_sensor_fail", "battery_short"]);

/**
 * What raises and clears alarms: the rules that connect the events of the perimeter (a node, a camera, the mode) and the reports of the
 * devices to the alarm centre.
 */
export class AlarmRules {
  constructor(private readonly centre: AlarmCentre, private readonly mode: () => SecurityMode) {}

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
        // Disarming ends every intrusion alarm: nothing is being defended any more.
        if (event.mode === "disarmed") this.centre.clearMatching(alarm => armedOnlyCodes.has(alarm.code) || alarm.code === "node_down" || alarm.code === "camera_down");
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
    if (message.kind === "inverter") {
      const fault = message.mode === "fault" || message.warnings.some(name => SOLAR_FAULTS.has(name));
      if (fault) this.centre.raise(`${base}:fault`, { source, severity: "high", code: "solar_fault" });
      else this.centre.clear(`${base}:fault`);
      const low = message.battery_percent < SOLAR_LOW || message.warnings.includes("battery_low") || message.warnings.includes("battery_under_shutdown");
      if (low) this.centre.raise(`${base}:battery`, { source, severity: "warning", code: "solar_battery_low" });
      else if (message.battery_percent >= SOLAR_OK) this.centre.clear(`${base}:battery`);
    } else if (message.modules > 0) {
      if (message.alarm === true) this.centre.raise(`${base}:battery_alarm`, { source, severity: "high", code: "solar_battery_alarm" });
      else this.centre.clear(`${base}:battery_alarm`);
      const soc = message.soc_percent;
      if (soc !== undefined && soc < SOLAR_LOW) this.centre.raise(`${base}:battery`, { source, severity: "warning", code: "solar_battery_low" });
      else if (soc !== undefined && soc >= SOLAR_OK) this.centre.clear(`${base}:battery`);
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

  /** An electrical node went silent, or came back. */
  handleElectricalStale(node: string, stale: boolean): void {
    if (stale) this.centre.raise(`electrical:${node}:offline`, { source: { type: "electrical", id: node }, severity: "warning", code: "electrical_offline" });
    else this.centre.clear(`electrical:${node}:offline`);
  }

  /** A device that was removed can no longer be in trouble. */
  forgetDevice(id: string): void { this.centre.clearMatching(alarm => alarm.source.type === "device" && alarm.source.id === id); }
}
