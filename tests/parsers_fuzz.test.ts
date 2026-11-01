/**
 * Every parser of a message or a document that the server takes from outside is fed deterministic garbage: whatever it is given it must either answer or refuse with
 * its own error, never crash with a TypeError or a RangeError of the language (an unguarded property read) and never hang. The generator is seeded, so a failure repeats.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseObservation } from "../src/ai.js";
import { parseAlarmCommand, parseAlarmMessage, parseAlarmResult } from "../src/alarm.js";
import { parseZoneLinks } from "../src/alarm_zone_feed.js";
import { parseArmProfile, parseProfileList } from "../src/arm_profiles.js";
import { parseArmingModes, parseModeDefinition, parsePanelSync } from "../src/arming_modes.js";
import { parseBatteryCommand, parseBatteryResult } from "../src/battery_ops.js";
import { parseCaptureSettings } from "../src/capture_on_detect.js";
import { parseHealth, parseInfo, parseTelemetry } from "../src/contracts.js";
import { parseElectricalCommand, parseElectricalMessage, parseElectricalResult } from "../src/electrical.js";
import { parseEnergyAlarmSettings } from "../src/energy_alarms.js";
import { parseIgnoreZones } from "../src/ignore_zones.js";
import { parseBundle } from "../src/installation.js";
import { parseNetworkMessage } from "../src/network.js";
import { parseControlCommand, parseControlResult, parseMaintenance } from "../src/node_control.js";
import { parseBootReport } from "../src/node_diag_contract.js";

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const JUNK: unknown[] = [null, undefined, true, false, 0, -1, 1e308, NaN, "", "x", "../../etc/passwd", "a".repeat(3000), [], {}, [[]], [null], [{}], "\u0000", 2 ** 53, 1.5, { __proto__: { admin: true } }, { constructor: 1 }, { length: -1 }];
const KEYS = ["kind", "node_id", "timestamp_ms", "phase", "mode", "zones", "open_zones", "events", "id", "name", "type", "value", "profiles", "schedule", "action", "command_id", "ports", "devices", "enabled", "version", "schema", "nodes", "readings", "state", "reason"];

/** A value of random shape: a scalar, a list or an object whose keys are the field names the parsers read. */
function wild(rand: () => number, depth = 0): unknown {
  const roll = rand();
  if (depth > 3 || roll < 0.45) return JUNK[Math.floor(rand() * JUNK.length)];
  if (roll < 0.65) return Array.from({ length: Math.floor(rand() * 4) }, () => wild(rand, depth + 1));
  const object: Record<string, unknown> = {};
  for (let index = 0, count = Math.floor(rand() * 7); index < count; index += 1) object[KEYS[Math.floor(rand() * KEYS.length)]] = wild(rand, depth + 1);
  return object;
}

const PARSERS: Array<[string, (value: unknown) => unknown]> = [
  ["parseObservation", parseObservation], ["parseAlarmMessage", parseAlarmMessage], ["parseAlarmCommand", parseAlarmCommand], ["parseAlarmResult", parseAlarmResult],
  ["parseZoneLinks", parseZoneLinks], ["parseArmProfile", value => parseArmProfile(value)], ["parseProfileList", parseProfileList], ["parseArmingModes", parseArmingModes],
  ["parseModeDefinition", value => parseModeDefinition(value, "away")], ["parsePanelSync", parsePanelSync], ["parseBatteryResult", parseBatteryResult], ["parseBatteryCommand", parseBatteryCommand],
  ["parseCaptureSettings", parseCaptureSettings], ["parseTelemetry", parseTelemetry], ["parseHealth", parseHealth], ["parseInfo", parseInfo],
  ["parseElectricalMessage", parseElectricalMessage], ["parseElectricalCommand", parseElectricalCommand], ["parseElectricalResult", parseElectricalResult],
  ["parseEnergyAlarmSettings", parseEnergyAlarmSettings], ["parseIgnoreZones", parseIgnoreZones], ["parseBundle", parseBundle], ["parseNetworkMessage", parseNetworkMessage],
  ["parseControlCommand", parseControlCommand], ["parseControlResult", parseControlResult], ["parseMaintenance", parseMaintenance], ["parseBootReport", parseBootReport],
];

for (const [name, parse] of PARSERS) {
  test(`${name} answers or refuses with its own error for any garbage, and never with a crash of the language`, () => {
    const rand = random(0xc0ffee ^ name.length);
    const started = Date.now();
    for (let round = 0; round < 400; round += 1) {
      const input = round < JUNK.length ? JUNK[round] : wild(rand);
      try { parse(input); }
      catch (error) {
        assert.ok(error instanceof Error, `${name} threw something that is not an Error for ${JSON.stringify(input)?.slice(0, 120)}`);
        assert.ok(!(error instanceof TypeError) && !(error instanceof RangeError), `${name} crashed with ${error.name}: ${error.message} for ${JSON.stringify(input)?.slice(0, 160)}`);
      }
    }
    assert.ok(Date.now() - started < 5000, `${name} took too long on garbage`);
  });
}
