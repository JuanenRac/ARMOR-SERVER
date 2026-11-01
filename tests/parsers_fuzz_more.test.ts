/**
 * Second fuzz sweep: the text parsers (system files, certificates, headers, checksums), the camera and rule parsers and the node-health and solar contracts.
 * Each one is fed seeded garbage, structured text and truncated valid text; it must answer or refuse with its own error, never crash with a TypeError or RangeError and never hang.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateBatteryParams } from "../src/battery_ops.js";
import { parseDigestChallenge } from "../src/cameras/digest.js";
import { parseCameraInput, parseTraits, parseWebUrl } from "../src/cameras/model.js";
import { parseOrigin } from "../src/config.js";
import { parsePayload } from "../src/devices/mapping.js";
import { parseChecksum } from "../src/firmware.js";
import { parseCaPem } from "../src/mqtt_tls.js";
import { parseConfigCheck, parseCoredumpFact, parseDiagnosticPackage, parseMemoryGate, parseRadarFacts, parseSensors } from "../src/node_diag_contract.js";
import { parseNodeHealth } from "../src/node_health.js";
import { parseRanges } from "../src/origin.js";
import { parsePersisted } from "../src/persistence.js";
import { parseServiceAccount } from "../src/push_fcm.js";
import { parseRadarEvent } from "../src/radar_events.js";
import { parseRules } from "../src/rules.js";
import { parseVisionServiceUrl } from "../src/security_settings.js";
import { parseSystemctlShow, parseSystemdTime } from "../src/services.js";
import { parseSolarBattery, parseSolarEvent, parseSolarInverter, parseSolarMessage } from "../src/solar.js";
import { parseMeminfo, parseMounts, parseNetDev, parseProcStat } from "../src/system_metrics.js";
import { parseVoiceTurnReply, parseVoiceTurnRequest } from "../src/voice_turn.js";

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
const KEYS = ["kind", "node_id", "timestamp_ms", "id", "name", "type", "value", "state", "rules", "url", "host", "port", "sensors", "readings", "inverter", "battery", "soc", "power", "voltage", "current", "traits", "ptz", "events", "memory", "free", "total", "zones", "targets", "x", "y", "reason"];
const TEXT_PIECES = ["\n", "\r\n", " ", "=", ":", "-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----", "MIIB", "cpu", "cpu0", "MemTotal:", "kB", "eth0", "wlan0", "/dev/sda1", "ext4", "nfs", "tmpfs", "ActiveState=active", "Id=armor.service", "ExecMainStartTimestamp=", "Mon 2026", "UTC", "Digest realm=\"x\"", "nonce=", "qop=\"auth\"", ",", "\"", "\\", "0", "-1", "99999999999999999999", "NaN", "{", "}", "[", "]", "10.0.0.0/8", "::1", "fe80::/10", "256.1.1.1", "/", "/33", "http://", "https://", "[::", "abc", "é", "\u0000"];

function wild(rand: () => number, depth = 0): unknown {
  const roll = rand();
  if (depth > 3 || roll < 0.45) return JUNK[Math.floor(rand() * JUNK.length)];
  if (roll < 0.65) return Array.from({ length: Math.floor(rand() * 4) }, () => wild(rand, depth + 1));
  const object: Record<string, unknown> = {};
  for (let index = 0, count = Math.floor(rand() * 7); index < count; index += 1) object[KEYS[Math.floor(rand() * KEYS.length)]] = wild(rand, depth + 1);
  return object;
}
function wildText(rand: () => number): string {
  let text = "";
  for (let index = 0, count = Math.floor(rand() * 24); index < count; index += 1) text += TEXT_PIECES[Math.floor(rand() * TEXT_PIECES.length)];
  return text;
}

function check(name: string, run: (round: number, rand: () => number) => void, rounds = 400): void {
  test(`${name} answers or refuses with its own error for any garbage`, () => {
    const rand = random(0xfeed ^ (name.length * 31));
    const started = Date.now();
    for (let round = 0; round < rounds; round += 1) {
      try { run(round, rand); }
      catch (error) {
        assert.ok(error instanceof Error, `${name} threw something that is not an Error`);
        assert.ok(!(error instanceof TypeError) && !(error instanceof RangeError), `${name} crashed with ${error.name}: ${error.message}`);
      }
    }
    assert.ok(Date.now() - started < 5000, `${name} took too long on garbage`);
  });
}

const VALUE_PARSERS: Array<[string, (value: unknown) => unknown]> = [
  ["parseCameraInput", value => parseCameraInput(value)], ["parseWebUrl", parseWebUrl], ["parseTraits", value => parseTraits(value !== null && typeof value === "object" ? value as Record<string, unknown> : {})],
  ["parseMemoryGate", parseMemoryGate], ["parseCoredumpFact", parseCoredumpFact], ["parseConfigCheck", parseConfigCheck], ["parseSensors", parseSensors], ["parseRadarFacts", parseRadarFacts],
  ["parseDiagnosticPackage", parseDiagnosticPackage], ["parseNodeHealth", parseNodeHealth], ["parseRadarEvent", parseRadarEvent], ["parseRules", parseRules],
  ["parseVisionServiceUrl", parseVisionServiceUrl], ["parseSolarInverter", parseSolarInverter], ["parseSolarBattery", parseSolarBattery], ["parseSolarMessage", parseSolarMessage],
  ["parseSolarEvent", value => parseSolarEvent(value, "fuzz")], ["validateBatteryParams", value => validateBatteryParams("set_charge_current", value)],
];
for (const [name, parse] of VALUE_PARSERS) check(name, (round, rand) => parse(round < JUNK.length ? JUNK[round] : wild(rand)));

const TEXT_PARSERS: Array<[string, (text: string) => unknown]> = [
  ["parseOrigin", parseOrigin], ["parseChecksum", parseChecksum], ["parseCaPem", text => parseCaPem(text)], ["parseRanges", parseRanges], ["parsePersisted", parsePersisted],
  ["parseServiceAccount", parseServiceAccount], ["parseSystemctlShow", parseSystemctlShow], ["parseSystemdTime", parseSystemdTime], ["parseProcStat", parseProcStat],
  ["parseMeminfo", parseMeminfo], ["parseNetDev", parseNetDev], ["parseMounts", parseMounts], ["parseDigestChallenge", parseDigestChallenge],
  ["parsePayload", text => parsePayload(text)], ["parsePayload(buffer)", text => parsePayload(Buffer.from(text))],
];
for (const [name, parse] of TEXT_PARSERS) {
  check(name, (round, rand) => {
    const roll = rand();
    parse(round === 0 ? "" : roll < 0.2 ? JSON.stringify(wild(rand)) ?? "" : roll < 0.3 ? "x".repeat(Math.floor(rand() * 5000)) : wildText(rand));
  });
}

check("parseVoiceTurnRequest", (round, rand) => {
  const types = ["", "multipart/form-data", "multipart/form-data; boundary=", "multipart/form-data; boundary=\"", "multipart/mixed; boundary=zz", "application/json", "audio/wav"];
  const boundary = ["", "zz", "--", "a".repeat(200)][Math.floor(rand() * 4)];
  const body = Buffer.from(rand() < 0.5 ? `--${boundary}\r\n${wildText(rand)}\r\n--${boundary}--` : wildText(rand));
  parseVoiceTurnRequest(types[Math.floor(rand() * types.length)] || `multipart/form-data; boundary=${boundary}`, round === 0 ? Buffer.alloc(0) : body, Math.floor(rand() * 50) - 5);
});
check("parseVoiceTurnReply", (round, rand) => {
  const types = ["", "multipart/form-data", "multipart/form-data; boundary=zz", "multipart/mixed; boundary=zz", "application/json", "audio/wav"];
  const body = Buffer.from(rand() < 0.5 ? `--zz\r\n${wildText(rand)}\r\n--zz--` : wildText(rand));
  parseVoiceTurnReply(types[Math.floor(rand() * types.length)], round === 0 ? Buffer.alloc(0) : body, Math.floor(rand() * 50) - 5);
});
