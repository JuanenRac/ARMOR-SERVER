/**
 * The wire format of the Wi-Fi dongle of many hybrid inverters (Eybond collectors: the ones the SmartESS, SmartClient and WatchPower Wi-Fi apps use) and the READING questions of the
 * inverter behind it (Voltronic PI30 and PI18). An eight-byte header (transaction, device code, length, address, function) and a payload; the inverter's own frames travel inside.
 *
 * Only reading can be built here. A frame to the dongle is a heartbeat or one of the questions of the fixed table below, picked by name: no function of this module takes a command text,
 * so a setting command (POP, PCP, PBT, ^S...) cannot be put together, and neither can the datagram that points a dongle at another server (this server never sends it).
 * The decoders follow ARMOR-NODE-SOLAR's, so a reading through the dongle and one through the node's serial port are the same message. NOTHING here has been tried on a real dongle.
 *
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 *
 * The transport (header, heartbeat, forwarding, device codes and routes) is adapted from ha-dessmonitor (https://github.com/andreas-glaser/ha-dessmonitor), under the MIT License:
 *
 *   Copyright (c) 2025 Andreas Christoph Glaser <andreas.glaser@pm.me>
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export const HEADER_SIZE = 8;
export const FC_HEARTBEAT = 1;
export const FC_FORWARD = 4;
/** The device codes tried when the dongle does not say one that works. */
export const KNOWN_DEVICE_CODES: readonly number[] = [2452, 258];

export type DongleHeader = { transaction: number; deviceCode: number; address: number; functionCode: number; payloadLength: number };

/** The eight bytes at the start of `data`; undefined when the length they declare is impossible or beyond `maxPayload`. */
export function readHeader(data: Buffer, maxPayload: number): DongleHeader | undefined {
  const payloadLength = data.readUInt16BE(4) + 6 - HEADER_SIZE;
  if (payloadLength < 0 || payloadLength > maxPayload) return undefined;
  return { transaction: data.readUInt16BE(0), deviceCode: data.readUInt16BE(2), address: data.readUInt8(6), functionCode: data.readUInt8(7), payloadLength };
}

function frame(transaction: number, deviceCode: number, address: number, functionCode: number, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(HEADER_SIZE + payload.length);
  out.writeUInt16BE(transaction & 0xffff, 0);
  out.writeUInt16BE(deviceCode & 0xffff, 2);
  out.writeUInt16BE(out.length - 6, 4);
  out.writeUInt8(address & 0xff, 6);
  out.writeUInt8(functionCode, 7);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** The heartbeat the maker's cloud sends too: the date and time in UTC and how often the next one comes, in seconds. */
export function heartbeatFrame(transaction: number, intervalS: number, now: Date): Buffer {
  const payload = Buffer.from([(now.getUTCFullYear() - 2000) & 0xff, now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), 0, 0]);
  payload.writeUInt16BE(Math.min(0xffff, Math.max(1, Math.round(intervalS))), 6);
  return frame(transaction, 0, 1, FC_HEARTBEAT, payload);
}

/** CRC-16/XMODEM. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

/** The two CRC bytes as the inverters put them on the wire: a byte that would read as '(', CR or LF is increased by one (`raw` leaves them). */
export function crcBytes(data: Uint8Array, raw = false): Buffer {
  const crc = crc16(data);
  return Buffer.from([crc >> 8, crc & 0xff].map(byte => (!raw && (byte === 0x28 || byte === 0x0d || byte === 0x0a) ? byte + 1 : byte)));
}

const withCrc = (text: string, raw = false): Buffer => { const head = Buffer.from(text, "ascii"); return Buffer.concat([head, crcBytes(head, raw), Buffer.from("\r")]); };
const pi18Question = (name: string): Buffer => withCrc(`^P${String(name.length + 3).padStart(3, "0")}${name}`, true);

/** Every question this server may ask an inverter: reading ones only, built once. */
const QUESTIONS = Object.freeze({
  QPI: withCrc("QPI"), QPIGS: withCrc("QPIGS"), QPIGS2: withCrc("QPIGS2"), QMOD: withCrc("QMOD"), QPIWS: withCrc("QPIWS"), QPIRI: withCrc("QPIRI"), QID: withCrc("QID"), QVFW: withCrc("QVFW"),
  PI: pi18Question("PI"), GS: pi18Question("GS"), MOD: pi18Question("MOD"), FWS: pi18Question("FWS"), ID: pi18Question("ID"), VFW: pi18Question("VFW"),
});
export type Question = keyof typeof QUESTIONS;
export const QUESTION_NAMES = Object.keys(QUESTIONS) as Question[];

/** The bytes of one question of the table (a copy); anything that is not a name of the table is refused. */
export function questionBytes(question: Question): Buffer {
  if (!Object.hasOwn(QUESTIONS, question)) throw new Error("not a reading question");
  return Buffer.from(QUESTIONS[question]);
}

/** The frame that carries one reading question to the inverter behind the dongle. */
export function questionFrame(transaction: number, question: Question, deviceCode: number, address: number): Buffer {
  return frame(transaction, deviceCode, address, FC_FORWARD, questionBytes(question));
}

/** Builds a frame as a dongle sends it (the simulated dongle of the tests uses it). */
export const dongleFrame = frame;

/** The text of an inverter's reply: "(...CRC CR" (PI30) or "^Dnnn...CRC CR" (PI18). "NAK" when the inverter refuses; undefined when the frame or its CRC is wrong. */
export function replyText(reply: Buffer): string | undefined {
  if (reply.length < 5 || reply[reply.length - 1] !== 0x0d) return undefined;
  const body = reply.subarray(0, reply.length - 3), sent = reply.subarray(reply.length - 3, reply.length - 1);
  if (!sent.equals(crcBytes(body)) && !(body[0] === 0x5e && sent.equals(crcBytes(body, true)))) return undefined;
  if (body.some(byte => byte < 0x20 || byte > 0x7e)) return undefined;
  const text = body.toString("ascii");
  if (text.startsWith("(")) return text === "(NAK" ? "NAK" : text.slice(1);
  if (text === "^0") return "NAK";
  const data = /^\^D(\d{3})(.*)$/.exec(text);
  return data && Number(data[1]) === data[2].length + 3 ? data[2] : undefined;
}

// ---- the decoders ----------------------------------------------------------------------------------------------------------------------

const MODES = ["power_on", "standby", "line", "battery", "fault", "power_saving", "shutdown", "unknown"] as const;
export type Mode = (typeof MODES)[number];

export type Status = {
  grid_v: number; grid_hz: number; out_v: number; out_hz: number; out_va: number; out_w: number; load_percent: number; bus_v?: number;
  battery_v: number; battery_a: number; battery_percent: number; pv_v: number; pv_a: number; pv_w: number; heatsink_c: number;
  ac_charging: boolean; pv_charging: boolean; load_on: boolean; clamped: string[];
};

const LIMITS: Record<string, readonly [number, number]> = {
  grid_v: [0, 600], grid_hz: [0, 100], out_v: [0, 600], out_hz: [0, 100], out_va: [0, 100_000], out_w: [0, 100_000], load_percent: [0, 200], battery_v: [0, 1000], battery_a: [-1000, 1000],
  battery_percent: [0, 100], pv_v: [0, 1500], pv_a: [0, 500], pv_w: [0, 100_000], heatsink_c: [-50, 200],
};
const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/** An absurd number is held at the limit the contract accepts and named, so the message still arrives with the warnings and the fault. */
function hold(status: Omit<Status, "clamped">): Status {
  const out: Status = { ...status, clamped: [] };
  const numbers = out as unknown as Record<string, number>;
  for (const [name, [low, high]] of Object.entries(LIMITS)) {
    const held = Math.min(high, Math.max(low, numbers[name]));
    if (held !== numbers[name]) out.clamped.push(name);
    numbers[name] = round(held, name === "battery_v" ? 2 : 1);
  }
  if (out.bus_v !== undefined && !(out.bus_v > 0 && out.bus_v <= 1500)) delete out.bus_v;
  return out;
}

const decimal = (text: string | undefined): number | undefined => (text !== undefined && text.length <= 12 && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text) ? Number(text) : undefined);
const decimals = (fields: string[], count: number): number[] | undefined => {
  const out = fields.slice(0, count).map(decimal);
  return out.length === count && out.every(value => value !== undefined) ? out as number[] : undefined;
};
const words = (text: string): string[] => text.split(" ").filter(Boolean);

export function parseQpigs(text: string): Status | undefined {
  const fields = words(text);
  const v = decimals(fields, 16), bits = fields[16];
  if (!v || !bits || !/^[01]{8}$/.test(bits)) return undefined;
  const pvPower = decimal(fields[19]);
  return hold({
    grid_v: v[0], grid_hz: v[1], out_v: v[2], out_hz: v[3], out_va: v[4], out_w: v[5], load_percent: v[6], bus_v: v[7], battery_v: v[8], battery_a: v[9] - v[15], battery_percent: v[10],
    heatsink_c: v[11], pv_a: v[12], pv_v: v[13], pv_w: pvPower ?? v[12] * v[13], load_on: bits[3] === "1", pv_charging: bits[6] === "1", ac_charging: bits[7] === "1",
  });
}

export type Pv2 = { pv2_a: number; pv2_v: number; pv2_w: number };
export function parseQpigs2(text: string): Pv2 | undefined {
  const v = decimals(words(text), 3);
  if (!v || v[0] < 0 || v[0] > 500 || v[1] < 0 || v[1] > 1500 || v[2] < 0 || v[2] > 100_000) return undefined;
  return { pv2_a: v[0], pv2_v: v[1], pv2_w: v[2] };
}

export function parseQmod(text: string): Mode | undefined {
  const modes: Record<string, Mode> = { P: "power_on", S: "standby", L: "line", B: "battery", F: "fault", H: "power_saving", D: "shutdown", C: "line", Y: "line", E: "power_saving" };
  return Object.hasOwn(modes, text) ? modes[text] : undefined;
}

const PI30_WARNINGS = ["pv_loss", "inverter_fault", "bus_over", "bus_under", "bus_soft_fail", "line_fail", "opv_short", "inverter_voltage_low", "inverter_voltage_high", "over_temperature",
  "fan_locked", "battery_voltage_high", "battery_low", "", "battery_under_shutdown", "battery_derating", "overload", "eeprom_fault", "inverter_over_current", "inverter_soft_fail", "self_test_fail",
  "op_dc_voltage_over", "battery_open", "current_sensor_fail", "battery_short", "power_limit", "pv_voltage_high", "mppt_overload_fault", "mppt_overload_warning", "battery_too_low_to_charge", "",
  "battery_weak", "battery_weak", "battery_weak", "", "battery_equalisation"];

export function parseQpiws(text: string): string[] | undefined {
  // the MAX documents put the digits of a fault code among the flags (places 31 to 33): any digit is let through there and only a '1' counts
  if (!text || text.length > 64 || [...text].some((c, i) => c !== "0" && c !== "1" && !(i >= 31 && i <= 33 && c >= "2" && c <= "9"))) return undefined;
  return [...new Set(PI30_WARNINGS.filter((name, bit) => name !== "" && text[bit] === "1"))].slice(0, 32);
}

const CHOICES = {
  battery_type: ["agm", "flooded", "user"], input_range: ["appliance", "ups"], output_priority: ["utility_first", "solar_first", "sbu"], charger_priority: ["utility_first", "solar_first", "solar_and_utility", "solar_only"],
} as const;
const RATING_FIELDS: ReadonlyArray<readonly [string, number, number]> = [["grid_rating_v", 0, 600], ["out_rating_v", 2, 600], ["out_rating_hz", 3, 100], ["out_rating_va", 5, 1_000_000], ["out_rating_w", 6, 1_000_000],
  ["battery_rating_v", 7, 600], ["battery_recharge_v", 8, 600], ["battery_under_v", 9, 600], ["battery_bulk_v", 10, 600], ["battery_float_v", 11, 600], ["max_ac_charge_a", 13, 2000], ["max_charge_a", 14, 2000]];

export type Ratings = Record<string, number | string>;
export function parseQpiri(text: string): Ratings | undefined {
  const fields = words(text);
  const v = fields.length >= 18 ? decimals(fields, 18) : undefined;
  if (!v) return undefined;
  const out: Ratings = {};
  for (const [name, index, high] of RATING_FIELDS) if (v[index] >= 0 && v[index] <= high) out[name] = v[index];
  for (const [name, index] of [["battery_type", 12], ["input_range", 15], ["output_priority", 16], ["charger_priority", 17]] as const) {
    const word = CHOICES[name][v[index]];
    if (word !== undefined) out[name] = word;
  }
  return out;
}

export const parseSerial = (text: string): string | undefined => (/^[0-9A-Za-z]{8,20}$/.test(text) && !/^0+$/.test(text) ? text : undefined);
export function parseFirmware(text: string): string | undefined {
  const value = text.slice(text.indexOf(":") + 1);
  return /^[0-9A-Za-z._-]{1,24}$/.test(value) ? value : undefined;
}

// ---- PI18: numbers separated by commas

export function parseGs(text: string): Status | undefined {
  const fields = text.split(",");
  if (fields.length < 27) return undefined;
  const v = decimals(fields, Math.min(fields.length, 28));
  // only the three temperatures may be below zero
  if (!v || v.some((value, i) => value < 0 && !(i >= 13 && i <= 15))) return undefined;
  const pvW = v[16] + v[17], pvV = (v[16] >= v[17] ? v[18] : v[19]) / 10;
  return hold({
    grid_v: v[0] / 10, grid_hz: v[1] / 10, out_v: v[2] / 10, out_hz: v[3] / 10, out_va: v[4], out_w: v[5], load_percent: v[6], battery_v: v[7] / 10, battery_a: v[11] - v[10], battery_percent: v[12],
    heatsink_c: v[13], pv_w: pvW, pv_v: pvV, pv_a: pvV > 1 ? pvW / pvV : 0, load_on: v[23] === 1, pv_charging: v[21] === 2 || v[22] === 2, ac_charging: v[25] === 1,
  });
}

export function parseMod18(text: string): Mode | undefined {
  const modes: Record<string, Mode> = { "00": "power_on", "01": "standby", "02": "line", "03": "battery", "04": "fault", "05": "line" };
  return Object.hasOwn(modes, text) ? modes[text] : undefined;
}

const PI18_WARNINGS = ["line_fail", "output_short", "over_temperature", "fan_locked", "battery_voltage_high", "battery_low", "battery_under_shutdown", "overload", "eeprom_fault", "power_limit",
  "pv_voltage_high", "pv2_voltage_high", "mppt_overload_warning", "mppt2_overload_warning", "battery_too_low_to_charge", "battery_too_low_to_charge_scc2"];
export function parseFws(text: string): string[] | undefined {
  const fields = text.split(",");
  const v = fields.length >= 17 ? decimals(fields, Math.min(fields.length, 24)) : undefined;
  if (!v || v.some(value => value < 0)) return undefined;
  const fault = v[0] > 0 && Number.isInteger(v[0]) && v[0] < 1000 ? ["inverter_fault", `fault_code_${v[0]}`] : [];
  return [...fault, ...PI18_WARNINGS.filter((_name, i) => v[i + 1] >= 1)];
}
