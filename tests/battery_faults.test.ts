// The three levels of a battery's states, and a module that does not read three of its cells (invented figures), from the node's message to the alarm.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { levelOf, UnreadCells } from "../src/battery_faults.js";
import { BatteryNotices } from "../src/battery_notices.js";
import { forwardCompatible } from "../src/contracts.js";
import { ENERGY_ALARM_DEFAULTS } from "../src/energy_alarms.js";
import { parseSolarMessage, type SolarBattery, type SolarModule } from "../src/solar.js";
import { tempDir } from "./helpers.js";

const cells = (dead: number[] = []): number[] => Array.from({ length: 15 }, (_, index) => (dead.includes(index) ? 0 : 3.33));
const message = (at: number, module: Partial<SolarModule>, extra: Partial<SolarBattery> = {}): SolarBattery => ({
  kind: "battery", node_id: "solar-1", device: "bank-1", timestamp_ms: at, modules: 1, stack: [{ n: 1, present: true, cells_v: cells(), ...module }], ...extra,
});

function rig() {
  const dir = tempDir();
  const notices = new BatteryNotices(path.join(dir, "battery-notices.json"), () => 1_000_000);
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json"), onRaised: alarm => notices.raised(alarm), onCleared: alarm => notices.cleared(alarm) });
  const rules = new AlarmRules(centre, () => "disarmed", () => ENERGY_ALARM_DEFAULTS);
  rules.batteryWorse = (key, id, subjects) => { if (notices.observe(key, id, subjects) && id) centre.waitAgain(id); };
  const open = (code: string) => centre.active().filter(alarm => !alarm.cleared_at && alarm.code === code);
  return { notices, centre, rules, open };
}

test("a High or a Low is a notice, a protection or an unknown word an alarm, SysError a fault", () => {
  assert.equal(levelOf({ column: "voltage", word: "High" }), 1);
  assert.equal(levelOf({ column: "current", word: "DOCAlm" }), 1);
  assert.equal(levelOf({ column: "system", word: "High" }), 2);
  assert.equal(levelOf({ column: "voltage", word: "OV" }), 2);
  assert.equal(levelOf({ column: "voltage", word: "NeverSeen" }), 2);
  assert.equal(levelOf({ column: "base", word: "SysError" }), 3);
});

test("the new fields of a node's message are read, and a state with an unknown member is dropped by the live reading", () => {
  const body = { ...message(1, { flags: [{ column: "voltage", word: "UV", cell: 3 }], cells_unread: [3, 4, 5], manufacturer: "Pylon", manufacturer_source: "reported", cells_v: cells([3, 4, 5]) }), manufacturer: "Pylon", manufacturer_source: "deduced" };
  const read = parseSolarMessage(structuredClone(body)) as SolarBattery;
  assert.equal(read.manufacturer, "Pylon");
  assert.deepEqual(read.stack[0]!.cells_unread, [3, 4, 5]);
  const later = structuredClone(body) as unknown as { stack: Array<{ flags: Array<Record<string, unknown>> }> };
  later.stack[0]!.flags[0]!.hint = "x";
  const { ignored } = forwardCompatible(() => parseSolarMessage(later));
  assert.deepEqual(ignored, ["module 0 state.hint"]);
});

test("three cells the node says it does not read are one fault that names them, and it ends when they are read again", () => {
  const { rules, open, centre, notices } = rig();
  const bad = message(1000, { cells_v: cells([3, 4, 5]), cells_unread: [3, 4, 5] }, { alarm: true });
  rules.handleSolar(bad);
  const [fault] = open("solar_battery_fault");
  assert.deepEqual(fault?.detail, { module: 1, cell: "4, 5, 6", bms_word: "0 V" });
  assert.equal(fault?.severity, "high");
  notices.silence("solar-1/bank-1", true, "owner");
  rules.handleSolar(message(2000, { cells_v: cells([3, 4, 5]), cells_unread: [3, 4, 5] }, { alarm: true }));
  assert.equal(open("solar_battery_fault").length, 1, "silencing takes the sound away, never the fault");
  assert.equal(notices.view(open("solar_battery_fault")[0]!).quiet, "silenced");
  rules.handleSolar(message(3000, {}));
  assert.equal(open("solar_battery_fault").length, 0);
  assert.equal(centre.active().some(alarm => alarm.code === "solar_battery_fault" && alarm.cleared_at !== undefined), true);
});

test("from a node that does not say it, a 0 V cell is a fault only when it repeats", () => {
  const { rules, open } = rig();
  rules.handleSolar(message(1000, { cells_v: cells([7]) }));
  assert.equal(open("solar_battery_fault").length, 0, "one spoiled reading");
  rules.handleSolar(message(1000, { cells_v: cells([7]) }));
  assert.equal(open("solar_battery_fault").length, 0, "the same reading again does not confirm itself");
  rules.handleSolar(message(2000, {}));
  rules.handleSolar(message(3000, { cells_v: cells([7]) }));
  assert.equal(open("solar_battery_fault").length, 0);
  rules.handleSolar(message(4000, { cells_v: cells([7]) }));
  assert.deepEqual(open("solar_battery_fault")[0]?.detail, { module: 1, cell: "8", bms_word: "0 V" });
});

test("SysError is a fault at once, and an alarm names the module, the column, the cell and the word", () => {
  const { rules, open } = rig();
  rules.handleSolar(message(1000, { state: "SysError", flags: [{ column: "base", word: "SysError" }, { column: "voltage", word: "OV", cell: 6 }] }, { alarm: true }));
  assert.equal(open("solar_battery_fault")[0]?.detail?.bms_word, "SysError");
  assert.deepEqual(open("solar_battery_alarm")[0]?.detail, { module: 1, column: "voltage", bms_word: "OV", cell: 7 });
  const unread = new UnreadCells();
  assert.deepEqual(unread.judge("a", { n: 1, present: true }, 1), []);
});
