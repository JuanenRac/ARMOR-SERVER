// The states that an ARMOR-RADAR node publishes for the devices of the server, exactly as its firmware writes them, through the server's device layer.
// tests/fixtures/firmware_device_states.txt is the output of ARMOR-RADAR's tests/emit_samples (the lines that start with "device_state"); regenerate it
// there whenever the firmware's serialiser changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isTriggered } from "../src/devices/catalog.js";
import { DeviceRegistry } from "../src/devices/registry.js";
import { tempDir } from "./helpers.js";

const samples = readFileSync(new URL("./fixtures/firmware_device_states.txt", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean)
  .map(line => { assert.ok(line.startsWith("device_state ")); return line.slice("device_state ".length); });
const registry = () => new DeviceRegistry({ file: path.join(tempDir(), "devices.json") });

test("the fixture holds what the firmware writes: presence, pins, numbers", () => {
  assert.equal(samples.length, 8);
  for (const sample of samples) assert.ok(typeof JSON.parse(sample) === "object");
});

test("a presence sensor of a node is a motion device: somebody there triggers it, nobody clears it, the distance is not a state field", () => {
  const devices = registry();
  const topic = "armor/device/perimetro-1/garage_presence/state";
  devices.create({ id: "garage-presence", name: "Garage presence", kind: "motion", source: { type: "mqtt", topic } });
  assert.deepEqual(devices.topics(), [topic]);
  const [somebodyAt, somebody, nobody] = samples;
  devices.ingestMqtt(topic, somebodyAt);
  let device = devices.get("garage-presence")!;
  assert.equal(device.state.triggered, true);
  assert.equal(isTriggered(device.kind, device.state), true);
  assert.equal("distance_cm" in device.state, false);
  devices.ingestMqtt(topic, nobody);
  device = devices.get("garage-presence")!;
  assert.equal(device.state.triggered, false);
  assert.equal(isTriggered(device.kind, device.state), false);
  devices.ingestMqtt(topic, somebody);
  assert.equal(devices.get("garage-presence")!.state.triggered, true);
  assert.equal(devices.get("garage-presence")!.online, true);
});

test("the states of mapped pins land on the fields they name", () => {
  const devices = registry();
  const contact = "armor/device/perimetro-1/door/state", lamp = "armor/device/perimetro-1/lamp/state", dimmer = "armor/device/perimetro-1/dimmer/state", battery = "armor/device/perimetro-1/battery/state";
  devices.create({ id: "door", name: "Door", kind: "door", source: { type: "mqtt", topic: contact } });
  devices.create({ id: "lamp", name: "Lamp", kind: "smart_light", source: { type: "mqtt", topic: lamp } });
  devices.create({ id: "dimmer", name: "Dimmer", kind: "smart_light", source: { type: "mqtt", topic: dimmer } });
  devices.create({ id: "battery", name: "Battery", kind: "climate", source: { type: "mqtt", topic: battery } });
  const byName = (needle: string) => samples.find(sample => sample.includes(needle))!;
  devices.ingestMqtt(contact, byName('"open":false'));
  assert.equal(devices.get("door")!.state.open, false);
  devices.ingestMqtt(lamp, byName('"on":true'));
  assert.equal(devices.get("lamp")!.state.on, true);
  devices.ingestMqtt(dimmer, byName('"brightness"'));
  assert.equal(devices.get("dimmer")!.state.brightness, 40);
  devices.ingestMqtt(battery, byName('"battery"'));
  assert.equal(devices.get("battery")!.state.battery, 12.6);
});
