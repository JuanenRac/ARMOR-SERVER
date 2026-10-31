import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { commandField, isCommand, resolveToggle, sendCommand } from "../src/devices/commands.js";
import { DeviceError, DeviceRegistry, type DeviceInput } from "../src/devices/registry.js";
import { durableRename, keepBackup } from "../src/durable.js";
import { tempDir } from "./helpers.js";

const registry = () => new DeviceRegistry({ file: path.join(tempDir(), "devices.json") });
const code = async (action: () => Promise<unknown>): Promise<string> => {
  try { await action(); } catch (error) { return error instanceof DeviceError ? error.code : "other"; }
  return "none";
};
const plug = (devices: DeviceRegistry, commands: DeviceInput["commands"]) => devices.create({ name: "Plug", kind: "smart_plug", commands }).id;

test("only on, off and toggle are commands", () => {
  assert.equal(isCommand("on"), true);
  assert.equal(isCommand("off"), true);
  assert.equal(isCommand("toggle"), true);
  assert.equal(isCommand("open"), false);
  assert.equal(isCommand(undefined), false);
});

test("the field a command sets depends on the kind of device", () => {
  const devices = registry();
  const lock = devices.create({ name: "Door lock", kind: "lock" });
  const valve = devices.create({ name: "Water valve", kind: "valve" });
  const light = devices.create({ name: "Plug", kind: "smart_plug" });
  assert.equal(commandField(lock), "locked");
  assert.equal(commandField(valve), "open");
  assert.equal(commandField(light), "on");
});

test("a toggle turns into the opposite of the last reported state", () => {
  const devices = registry();
  const id = plug(devices, {});
  assert.equal(resolveToggle(devices.get(id)!), "on");
  devices.applyState(id, { on: true });
  assert.equal(resolveToggle(devices.get(id)!), "off");
});

test("a command for a device that is not there is refused with 404", async () => {
  const devices = registry();
  await assert.rejects(sendCommand(devices, "nothing", "on", {}), (error: unknown) => error instanceof DeviceError && error.code === "not_found" && error.status === 404);
});

test("a command the kind does not take is refused before anything is sent", async () => {
  const devices = registry();
  const id = devices.create({ name: "Door lock", kind: "lock", commands: { mqtt: { topic: "lock/cmd", on: "1", off: "0" } } }).id;
  const sent: string[] = [];
  assert.equal(await code(() => sendCommand(devices, id, "toggle", { publish: topic => { sent.push(topic); } })), "unsupported_command");
  assert.deepEqual(sent, []);
});

test("a device without a command topic or URL has no channel", async () => {
  const devices = registry();
  const id = plug(devices, {});
  assert.equal(await code(() => sendCommand(devices, id, "on", {})), "no_command_channel");
});

test("a command goes over MQTT and the state is assumed only when the device asks for it", async () => {
  const devices = registry();
  const assumed = plug(devices, { mqtt: { topic: "plug/a/cmd", on: "ON", off: "OFF", assume_state: true } });
  const plain = plug(devices, { mqtt: { topic: "plug/b/cmd", on: "ON", off: "OFF" } });
  const sent: [string, string][] = [];
  const deps = { publish: (topic: string, payload: string) => { sent.push([topic, payload]); } };
  assert.deepEqual(await sendCommand(devices, assumed, "on", deps), { via: "mqtt", command: "on" });
  assert.equal(devices.get(assumed)!.state.on, true);
  assert.deepEqual(await sendCommand(devices, plain, "on", deps), { via: "mqtt", command: "on" });
  assert.equal(devices.get(plain)!.state.on, undefined);
  assert.deepEqual(sent, [["plug/a/cmd", "ON"], ["plug/b/cmd", "ON"]]);
});

test("a toggle without a toggle payload of its own is sent as the opposite of the reported state", async () => {
  const devices = registry();
  const id = plug(devices, { mqtt: { topic: "plug/c/cmd", on: "ON", off: "OFF" } });
  devices.applyState(id, { on: true });
  const sent: string[] = [];
  const answer = await sendCommand(devices, id, "toggle", { publish: (_topic, payload) => { sent.push(payload); } });
  assert.deepEqual(answer, { via: "mqtt", command: "off" });
  assert.deepEqual(sent, ["OFF"]);
});

test("a toggle payload of the device is sent as it is and assumes no state", async () => {
  const devices = registry();
  const id = plug(devices, { mqtt: { topic: "plug/d/cmd", toggle: "T", assume_state: true } });
  const sent: string[] = [];
  const answer = await sendCommand(devices, id, "toggle", { publish: (_topic, payload) => { sent.push(payload); } });
  assert.deepEqual(answer, { via: "mqtt", command: "toggle" });
  assert.deepEqual(sent, ["T"]);
  assert.equal(devices.get(id)!.state.on, undefined);
});

test("a command over HTTP is a GET, sets the state and a failure is a 409", async () => {
  const devices = registry();
  const id = plug(devices, { http: { on: "http://192.168.1.50/on", off: "http://192.168.1.50/off" } });
  const urls: string[] = [];
  const okFetch = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response("ok", { status: 200 }); }) as typeof fetch;
  assert.deepEqual(await sendCommand(devices, id, "on", { fetchImpl: okFetch }), { via: "http", command: "on" });
  assert.deepEqual(urls, ["http://192.168.1.50/on"]);
  assert.equal(devices.get(id)!.state.on, true);

  const badFetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
  assert.equal(await code(() => sendCommand(devices, id, "off", { fetchImpl: badFetch })), "command_failed");
  const failingFetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  assert.equal(await code(() => sendCommand(devices, id, "off", { fetchImpl: failingFetch })), "command_failed");
  assert.equal(devices.get(id)!.state.on, true);
});

test("a command with nothing set up for it says which command", async () => {
  const devices = registry();
  const id = plug(devices, { http: { on: "http://192.168.1.50/on" } });
  const error = await sendCommand(devices, id, "off", { fetchImpl: (async () => new Response("ok")) as typeof fetch }).catch((caught: unknown) => caught);
  assert.ok(error instanceof DeviceError);
  assert.equal(error.code, "no_command_channel");
  assert.match(error.message, /"off"/);
});

test("a durable rename replaces the target and leaves no temporary file", () => {
  const folder = tempDir();
  const target = path.join(folder, "data.json");
  const temporary = `${target}.tmp`;
  fs.writeFileSync(target, "old");
  fs.writeFileSync(temporary, "new");
  durableRename(temporary, target);
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.existsSync(temporary), false);
});

test("a backup keeps the last good copy and does nothing when there is none", () => {
  const folder = tempDir();
  const target = path.join(folder, "data.json");
  keepBackup(target);
  assert.equal(fs.existsSync(`${target}.bak`), false);
  fs.writeFileSync(target, "good");
  keepBackup(target);
  assert.equal(fs.readFileSync(`${target}.bak`, "utf8"), "good");
});
