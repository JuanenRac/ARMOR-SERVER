// What the makers' manuals say about each battery model: the catalogue's figures, the models added, and the alert over the voltage at which the battery's own protection acts.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules, type Alarm } from "../src/alarms.js";
import type { SolarBattery } from "../src/solar.js";
import { BATTERY_FAMILIES, BATTERY_MODELS, batteryProfile, exampleReading, isBatteryModel, modelLabel, type SolarRegistration } from "../src/solar_registry.js";
import { tempDir } from "./helpers.js";

test("the 24 V UP2500 is eight cells of about 111 Ah, the UP5000 fifteen cells, and the Fidus and UF5000 are in the catalogue", () => {
  assert.deepEqual([BATTERY_FAMILIES["pylontech-up2500"]!.cells, BATTERY_FAMILIES["pylontech-up2500"]!.ah, BATTERY_FAMILIES["pylontech-up5000"]!.cells], [8, 111, 15]);
  for (const model of ["pylontech-uf5000", "pylontech-fidus-fb-l-5-12-eu", "pylontech-fidus-fb-l-5-12-eu-pro"]) {
    assert.ok(isBatteryModel(model) && (BATTERY_MODELS as readonly string[]).includes(model), model);
    assert.equal(BATTERY_FAMILIES[model]!.cells, 16);
    assert.equal(BATTERY_FAMILIES[model]!.ah, 100);
  }
  assert.equal(modelLabel("pylontech-fidus-fb-l-5-12-eu-pro"), "Pylontech Fidus FB-L-5.12-EU Pro");
});

test("no profile assumes 48 V: each says its own nominal voltage, and the figures are in a sane order", () => {
  assert.equal(batteryProfile("pylontech-up2500")!.nominal_v, 25.6);
  assert.equal(batteryProfile("pylontech-fidus-fb-l-5-12-eu")!.nominal_v, 51.2);
  assert.equal(batteryProfile("pylontech-us3000c")!.nominal_v, 48);
  assert.equal(batteryProfile("ant-bms-16s-100a"), undefined);
  assert.equal(batteryProfile("other"), undefined);
  for (const [model, family] of Object.entries(BATTERY_FAMILIES)) {
    const profile = family.profile;
    if (!profile) continue;
    if (profile.charge_v) assert.ok(profile.charge_v[0] < profile.charge_v[1] && profile.charge_v[1] <= profile.nominal_v * 1.2, model);
    if (profile.discharge_min_v !== undefined && profile.charge_v) assert.ok(profile.discharge_min_v < profile.charge_v[0], model);
    if (profile.over_v !== undefined && profile.charge_v) assert.ok(profile.over_v >= profile.charge_v[1], model);
    for (const range of [profile.charge_temp_c, profile.discharge_temp_c]) if (range) assert.ok(range[0] < range[1], model);
  }
  assert.deepEqual([batteryProfile("pylontech-us2000")!.max_group, batteryProfile("pylontech-us3000c")!.max_group, batteryProfile("pylontech-up2500")!.max_group], [8, 16, 20]);
  assert.equal(batteryProfile("pylontech-us5000")!.discharge_min_v, 43.5);
  assert.equal(batteryProfile("pylontech-fidus-fb-l-5-12-eu-pro")!.discharge_min_v, 42.5);
});

test("an example reading of each model has the cells of its model, and the voltage of a 24 V battery is about 25 V", () => {
  for (const model of ["pylontech-up2500", "pylontech-up5000", "pylontech-uf5000", "pylontech-fidus-fb-l-5-12-eu"]) {
    const registration: SolarRegistration = { node_id: "n", device: "d", kind: "battery", name: "x", model, connection: "rs232", notes: "", created_at: "x" };
    const reading = exampleReading(registration, 1_000_000) as SolarBattery;
    assert.equal(reading.stack[0]!.cells_v!.length, BATTERY_FAMILIES[model]!.cells, model);
  }
  const up2500 = exampleReading({ node_id: "n", device: "d", kind: "battery", name: "x", model: "pylontech-up2500", connection: "rs232", notes: "", created_at: "x" }, 1_000_000) as SolarBattery;
  assert.ok(up2500.voltage_v! > 24 && up2500.voltage_v! < 30, String(up2500.voltage_v));
});

test("a pack over the voltage at which its model's protection acts is an alert, and only for a model that has the figure", () => {
  const raised: Alarm[] = [];
  const centre = new AlarmCentre({ file: path.join(tempDir(), "alarms.json"), onRaised: alarm => { raised.push(alarm); } });
  const rules = new AlarmRules(centre, () => "disarmed");
  const models: Record<string, string> = { "solar-1/fidus": "pylontech-fidus-fb-l-5-12-eu", "solar-1/us": "pylontech-us3000c" };
  rules.batteryProfileOf = id => (models[id] ? batteryProfile(models[id]!) : undefined);
  const at = (device: string, voltage: number): SolarBattery => ({ kind: "battery", node_id: "solar-1", device, timestamp_ms: 1, modules: 1, voltage_v: voltage, stack: [{ n: 1, present: true }] });
  rules.handleSolar(at("fidus", 56.9));
  rules.handleSolar(at("us", 58));
  assert.equal(raised.filter(a => a.code === "solar_battery_overvoltage").length, 0, "56.9 V is under the Fidus figure, and a US3000C has none");
  rules.handleSolar(at("fidus", 57.8));
  assert.equal(raised.filter(a => a.code === "solar_battery_overvoltage").length, 1);
  rules.handleSolar(at("fidus", 57.9));
  assert.equal(raised.filter(a => a.code === "solar_battery_overvoltage").length, 1, "one alarm while it lasts");
});
