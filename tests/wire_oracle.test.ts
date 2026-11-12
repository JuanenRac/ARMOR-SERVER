// The readers of the messages against the oracle of ARMOR-COMMON: the verdict of the Python validator for the valid vectors and seeded mutations of them (conformance/wire_cases.tsv).
// The generated parsers (src/armor-parsers.ts) must agree on every case, and each reader written by hand for a message must accept what the contract accepts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkMessage, parseMessage, type MessageName } from "../src/armor-parsers.js";
import { parseAlarmCommand, parseAlarmMessage, parseAlarmResult } from "../src/alarm.js";
import { parseElectricalCommand, parseElectricalMessage, parseElectricalResult } from "../src/electrical.js";
import { parseHealth, parseInfo, parseTelemetry } from "../src/contracts.js";
import { parseNetworkMessage } from "../src/network.js";
import { parseControlCommand, parseControlResult, parseMaintenance } from "../src/node_control.js";
import { parseNodeHealth } from "../src/node_health.js";
import { parseRadarEvent } from "../src/radar_events.js";
import { parseSolarBattery, parseSolarInverter } from "../src/solar.js";

const common = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON");
const file = path.join(common, "conformance", "wire_cases.tsv");
const available = fs.existsSync(file);
const skip = available ? false : "ARMOR-COMMON is not checked out next to this repository";
if (!available && process.env.ARMOR_REQUIRE_SIBLINGS) throw new Error("ARMOR_REQUIRE_SIBLINGS is set and ARMOR-COMMON/conformance/wire_cases.tsv is missing");

type Case = { number: number; schema: string; valid: boolean; text: string; document: unknown };
const cases: Case[] = available
  ? fs.readFileSync(file, "utf8").split("\n").filter(line => line !== "").map((line, index) => {
      const [schema, verdict, text] = [line.slice(0, line.indexOf("\t")), line[line.indexOf("\t") + 1], line.slice(line.indexOf("\t", line.indexOf("\t") + 1) + 1)];
      return { number: index + 1, schema, valid: verdict === "1", text, document: JSON.parse(text) as unknown };
    })
  : [];

test("the generated parsers agree with the Python validator on every seeded case", { skip }, () => {
  assert.ok(cases.length > 500, "the oracle has a few hundred cases");
  const disagreements = cases.filter(item => (checkMessage(item.schema as MessageName, item.document) === undefined) !== item.valid).map(item => `${item.number} ${item.schema}`);
  assert.deepEqual(disagreements, []);
});

test("parseMessage gives the document back typed, or says where it is wrong", { skip }, () => {
  const valid = cases.find(item => item.valid && item.schema === "telemetry");
  const invalid = cases.find(item => !item.valid && item.schema === "telemetry");
  assert.ok(valid && invalid);
  assert.equal(parseMessage("telemetry", valid.document).node_id, (valid.document as { node_id: string }).node_id);
  assert.throws(() => parseMessage("telemetry", invalid.document), /: /);
});

/** The readers of the server that read a whole message, by the schema they read. */
const READERS: Record<string, (value: unknown) => unknown> = {
  telemetry: parseTelemetry, health: parseHealth, info: parseInfo,
  alarm: parseAlarmMessage, alarm_command: parseAlarmCommand, alarm_result: parseAlarmResult,
  electrical: parseElectricalMessage, electrical_command: parseElectricalCommand, electrical_result: parseElectricalResult,
  network: parseNetworkMessage, node_control_command: parseControlCommand, node_control_result: parseControlResult, node_maintenance: parseMaintenance,
  node_health: parseNodeHealth, radar_event: parseRadarEvent, solar_inverter: parseSolarInverter, solar_battery: parseSolarBattery,
};

const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** What a schema can not say and the contract does (docs/CONTRACTS.md): a rule between two fields. The readers by hand refuse a document that breaks one even though each field is right. */
const BETWEEN_FIELDS = new RegExp([
  "exactly when", "goes on an arm and on nothing else", "names a zone of the message", "a direction goes with a tripwire", "a signal strength goes only with",
  "a token goes on", "a token is given only in the result", "belong to a restarting answer only", "the base of the profile is the mode", "says how long it was down but is not an end",
].join("|"));

for (const [schema, read] of Object.entries(READERS)) {
  test(`the reader of ${schema} accepts every valid case of the oracle, but for the rules between fields`, { skip }, () => {
    const refused = cases.filter(item => item.schema === schema && item.valid).flatMap(item => {
      try { read(clone(item.document)); return []; } catch (error) { return [{ number: item.number, why: (error as Error).message }]; }
    });
    assert.deepEqual(refused.filter(item => !BETWEEN_FIELDS.test(item.why)), [], "a message the contract accepts was refused for a reason that is not a rule between fields");
  });
}

/** Where a hand-written reader is more lenient than the contract: it takes a document the contract refuses. They are listed so that a new one is noticed (and a closed one removed). */
const LENIENT: Record<string, number[]> = {};

for (const [schema, read] of Object.entries(READERS)) {
  test(`the reader of ${schema} refuses what the contract refuses`, { skip }, () => {
    const accepted = cases.filter(item => item.schema === schema && !item.valid).filter(item => { try { read(clone(item.document)); return true; } catch { return false; } }).map(item => item.number);
    assert.deepEqual(accepted, LENIENT[schema] ?? [], "a message the contract refuses was accepted");
  });
}
