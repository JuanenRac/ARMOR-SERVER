// The automation engine on its own, with a fake clock and a recording runner: when it fires, when it must not, and what it refuses to store.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AutomationEngine, AutomationError, MAX_ACTIONS, MAX_AUTOMATIONS, MAX_RUNS_PER_MINUTE, type Action, type Automation } from "../src/automations.js";
import type { Alarm } from "../src/alarms.js";
import type { DeviceChange } from "../src/devices/registry.js";
import type { SecurityMode } from "../src/store.js";
import { tempDir } from "./helpers.js";

type Harness = { engine: AutomationEngine; ran: string[]; results: Array<[boolean, string | undefined]>; mode: { value: SecurityMode }; clock: { ms: number }; file: string };
function harness(file = path.join(tempDir(), "automations.json"), failing = false): Harness {
  const ran: string[] = [], results: Array<[boolean, string | undefined]> = [], mode = { value: "disarmed" as SecurityMode }, clock = { ms: Date.parse("2026-01-01T00:00:00Z") };
  const engine = new AutomationEngine({
    file, mode: () => mode.value, now: () => new Date(clock.ms),
    run: async (action: Action) => { if (failing) throw new Error("the device did not answer"); ran.push(action.type === "device" ? `${action.device_id}=${action.command}` : "notify"); },
    onResult: (_automation: Automation, _action: Action, ok: boolean, detail?: string) => results.push([ok, detail]),
  });
  return { engine, ran, results, mode, clock, file };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const change = (id: string, field: string, from: unknown, to: unknown): DeviceChange => ({ device: { id } as DeviceChange["device"], changes: [{ field, from, to }] } as DeviceChange);
const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: "a1", severity: "critical", source: { type: "node", id: "radar-1" }, ...over } as Alarm);
const lamp: Action = { type: "device", device_id: "lamp", command: "on" };
const armed = { type: "mode", mode: "armed" } as const;

test("a threshold fires when the value crosses it, not on every report beyond it, in both directions", async () => {
  const h = harness();
  h.engine.create({ name: "hot", trigger: { type: "device", device_id: "probe", field: "temperature", equals: 30, op: "gt" }, actions: [lamp] });
  h.engine.create({ name: "cold", trigger: { type: "device", device_id: "probe", field: "temperature", equals: 5, op: "lt" }, actions: [{ type: "notify" }] });
  h.engine.handleDevice(change("probe", "temperature", 29, 31)); await settle();
  assert.deepEqual(h.ran, ["lamp=on"]);
  h.engine.handleDevice(change("probe", "temperature", 31, 35)); await settle();
  assert.equal(h.ran.length, 1, "still above: nothing new");
  h.engine.handleDevice(change("probe", "temperature", 4, 3)); await settle();
  assert.equal(h.ran.length, 1, "still below");
  h.engine.handleDevice(change("probe", "temperature", 6, 4)); await settle();
  assert.deepEqual(h.ran, ["lamp=on", "notify"]);
  h.engine.handleDevice(change("probe", "temperature", undefined, 40)); await settle();
  assert.equal(h.ran.length, 3, "a first report above the threshold counts as crossing");
  h.engine.handleDevice(change("probe", "temperature", 20, "hot")); await settle();
  h.engine.handleDevice(change("other", "temperature", 20, 99)); await settle();
  h.engine.handleDevice(change("probe", "humidity", 20, 99)); await settle();
  assert.equal(h.ran.length, 3, "a text value, another device, another field: nothing");
});

test("an equality trigger waits for exactly the value, and a boolean is not a number", async () => {
  const h = harness();
  h.engine.create({ name: "open", trigger: { type: "device", device_id: "door", field: "contact", equals: true }, actions: [lamp] });
  h.engine.handleDevice(change("door", "contact", true, false)); await settle();
  h.engine.handleDevice(change("door", "contact", false, 1)); await settle();
  assert.equal(h.ran.length, 0);
  h.engine.handleDevice(change("door", "contact", false, true)); await settle();
  assert.equal(h.ran.length, 1);
});

test("an automation limited to one mode, or switched off, does not run in the other", async () => {
  const h = harness();
  const armedOnly = h.engine.create({ name: "armed only", when_mode: "armed", trigger: { type: "alarm" }, actions: [lamp] });
  h.engine.create({ name: "off", enabled: false, trigger: { type: "alarm" }, actions: [{ type: "notify" }] });
  h.engine.handleAlarm(alarm()); await settle();
  assert.deepEqual(h.ran, [], "disarmed, and the other one is disabled");
  h.mode.value = "armed";
  h.engine.handleAlarm(alarm()); await settle();
  assert.deepEqual(h.ran, ["lamp=on"]);
  assert.equal(h.engine.get(armedOnly.id)!.runs, 1);
  assert.equal(h.engine.get(armedOnly.id)!.last_run, new Date(h.clock.ms).toISOString());
});

test("an alarm trigger filters by severity, kind of source and source id; a silent alarm sets nothing off", async () => {
  const h = harness();
  h.engine.create({ name: "radar critical", trigger: { type: "alarm", severity: "critical", source_type: "node", source_id: "radar-1" }, actions: [lamp] });
  for (const other of [alarm({ severity: "warning" }), alarm({ source: { type: "camera", id: "radar-1" } as Alarm["source"] }), alarm({ source: { type: "node", id: "radar-2" } as Alarm["source"] })]) h.engine.handleAlarm(other);
  await settle();
  assert.equal(h.ran.length, 0);
  h.engine.handleAlarm(alarm({ silent: true })); await settle();
  assert.equal(h.ran.length, 0, "a duress disarm must not light a lamp or sound a siren");
  h.engine.handleAlarm(alarm()); await settle();
  assert.equal(h.ran.length, 1);
});

test("a mode trigger answers only the mode it names", async () => {
  const h = harness();
  h.engine.create({ name: "on arm", trigger: armed, actions: [lamp] });
  h.engine.handleMode("disarmed"); await settle();
  assert.equal(h.ran.length, 0);
  h.engine.handleMode("armed"); await settle();
  assert.equal(h.ran.length, 1);
});

test("an automation runs at most six times a minute, whatever flaps; a minute later it runs again", async () => {
  const h = harness();
  const made = h.engine.create({ name: "flapping", trigger: armed, actions: [lamp] });
  for (let index = 0; index < MAX_RUNS_PER_MINUTE + 4; index += 1) await h.engine.runNow(made.id);
  assert.equal(h.ran.length, MAX_RUNS_PER_MINUTE);
  assert.equal(h.results.filter(([ok, detail]) => !ok && detail === "rate limited").length, 4);
  assert.equal(h.engine.get(made.id)!.runs, MAX_RUNS_PER_MINUTE, "a refused run is not counted");
  h.clock.ms += 61_000;
  await h.engine.runNow(made.id);
  assert.equal(h.ran.length, MAX_RUNS_PER_MINUTE + 1);
});

test("a failing device is reported, does not stop the other actions, and does not throw", async () => {
  const h = harness(undefined, true);
  const made = h.engine.create({ name: "two", trigger: armed, actions: [lamp, { type: "notify" }] });
  await h.engine.runNow(made.id);
  assert.deepEqual(h.results, [[false, "the device did not answer"], [false, "the device did not answer"]]);
  await assert.rejects(() => h.engine.runNow("nope"), (error: unknown) => error instanceof AutomationError && error.status === 404 && error.code === "not_found");
});

test("what is stored is cleaned: names, ids, limits, durations, and triggers that do not make sense are refused with their code", () => {
  const h = harness();
  const bad = (input: Record<string, unknown>, code: string) => assert.throws(() => h.engine.create(input as never), (error: unknown) => error instanceof AutomationError && error.code === code, JSON.stringify(input).slice(0, 80));
  const trigger = armed;
  bad({ trigger, actions: [lamp] }, "invalid_name");
  bad({ name: "   ", trigger, actions: [lamp] }, "invalid_name");
  bad({ name: "x", trigger: { type: "mode", mode: "away" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a b", field: "state", equals: true }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a", field: "Bad Field", equals: true }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a", field: "state", equals: "yes" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a", field: "state", equals: Infinity }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a", field: "state", equals: true, op: "gt" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "device", device_id: "a", field: "state", equals: 1, op: "ne" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "alarm", severity: "info" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "alarm", source_type: "moon" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: { type: "alarm", source_id: "../etc" }, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger: undefined, actions: [lamp] }, "invalid_trigger");
  bad({ name: "x", trigger, actions: [] }, "invalid_actions");
  bad({ name: "x", trigger, actions: "lamp" }, "invalid_actions");
  bad({ name: "x", trigger, actions: Array(MAX_ACTIONS + 1).fill(lamp) }, "invalid_actions");
  bad({ name: "x", trigger, actions: [{ type: "device", device_id: "lamp", command: "explode" }] }, "invalid_actions");
  bad({ name: "x", trigger, actions: [{ type: "device", device_id: "../lamp", command: "on" }] }, "invalid_actions");
  bad({ name: "x", trigger, actions: [null] }, "invalid_actions");
  assert.equal(h.engine.list().length, 0, "a refused automation leaves nothing behind");

  const ok = h.engine.create({ name: "  Light Up The Hall  ", trigger, actions: [{ type: "device", device_id: "lamp", command: "on", for_s: 99_999 }, { type: "device", device_id: "lamp", command: "toggle", for_s: 30 }, { type: "device", device_id: "lamp", command: "off", for_s: -5 }, { type: "notify" }] });
  assert.equal(ok.id, "light-up-the-hall");
  assert.equal(ok.name, "Light Up The Hall");
  assert.deepEqual(ok.actions.map(action => (action.type === "device" ? action.for_s : "n")), [3600, undefined, undefined, "n"], "capped at an hour; a toggle or a negative time has no switch-back");
  assert.equal(h.engine.create({ name: "Light up the hall", trigger, actions: [lamp] }).id, "light-up-the-hall-2", "a repeated name gets a free id");
  assert.equal(h.engine.create({ name: "???", trigger, actions: [lamp] }).id.startsWith("auto-"), true, "a name with no letters still gets an id");
});

test("updating keeps what is not mentioned, refuses a bad change whole, and a missing automation is a 404", () => {
  const h = harness();
  const made = h.engine.create({ name: "keep", trigger: armed, actions: [lamp], when_mode: "armed" });
  assert.equal(h.engine.update(made.id, { enabled: false }).name, "keep");
  assert.equal(h.engine.update(made.id, { name: "   " }).name, "keep", "an empty name keeps the old one");
  assert.equal(h.engine.update(made.id, { when_mode: "nonsense" as never }).when_mode, "any");
  assert.throws(() => h.engine.update(made.id, { actions: [] }), AutomationError);
  assert.deepEqual(h.engine.get(made.id)!.actions, [lamp], "the refused change did not half-apply");
  assert.throws(() => h.engine.update("nope", {}), (error: unknown) => error instanceof AutomationError && error.status === 404);
  assert.throws(() => h.engine.remove("nope"), (error: unknown) => error instanceof AutomationError && error.status === 404);
  h.engine.remove(made.id);
  assert.equal(h.engine.list().length, 0);
});

test("there is a ceiling on how many automations exist", () => {
  const h = harness();
  for (let index = 0; index < MAX_AUTOMATIONS; index += 1) h.engine.create({ name: `n${index}`, trigger: armed, actions: [lamp] });
  assert.throws(() => h.engine.create({ name: "one more", trigger: armed, actions: [lamp] }), (error: unknown) => error instanceof AutomationError && error.code === "too_many" && error.status === 409);
});

test("on start, damaged entries are skipped one by one, the good ones kept, and a file that cannot be written is only a warning", () => {
  const file = path.join(tempDir(), "automations.json");
  const good = { id: "good", name: "good", enabled: true, trigger: armed, when_mode: "any", actions: [{ type: "notify" }], created_at: "x", last_run: null, runs: 3 };
  fs.writeFileSync(file, JSON.stringify({ automations: [null, 5, { id: "Bad Id" }, { id: "no-trigger", actions: [{ type: "notify" }] }, { ...good, id: "no-actions", actions: [] }, good, { ...good, id: "weird", name: 7, enabled: 0, runs: "many", when_mode: "sometimes" }], pending: [null, { automation_id: "good", device_id: "../x", command: "on", due_ms: 1 }, { automation_id: "good", device_id: "lamp", command: "toggle", due_ms: 1 }] }));
  const h = harness(file);
  assert.deepEqual(h.engine.list().map(item => item.id), ["good", "weird"]);
  const weird = h.engine.get("weird")!;
  assert.deepEqual([weird.name, weird.enabled, weird.runs, weird.when_mode], ["7", true, 0, "any"]);
  assert.equal(h.engine.get("good")!.runs, 3);
  for (const content of ["", "{", "null", "[]", "{\"automations\":\"x\"}"]) { fs.writeFileSync(file, content); assert.equal(harness(file).engine.list().length, 0, content); }

  const warnings: string[] = [];
  const blocked = path.join(tempDir(), "file");
  fs.writeFileSync(blocked, "x");
  const engine = new AutomationEngine({ file: path.join(blocked, "inside", "a.json"), mode: () => "armed", run: async () => undefined, warn: message => warnings.push(message) });
  engine.create({ name: "x", trigger: armed, actions: [lamp] });
  engine.flush();
  assert.equal(warnings.length >= 1 && /could not be written/.test(warnings[0]!), true);
  engine.close();
});

test("a switch-back is saved to the file, a second trigger replaces the first one, and closing leaves nothing running", async () => {
  const h = harness();
  const made = h.engine.create({ name: "siren", trigger: armed, actions: [{ type: "device", device_id: "siren", command: "on", for_s: 600 }] });
  await h.engine.runNow(made.id);
  h.clock.ms += 1000;
  await h.engine.runNow(made.id);
  h.engine.flush();
  const saved = JSON.parse(fs.readFileSync(h.file, "utf8")) as { pending: Array<{ device_id: string; command: string; due_ms: number }> };
  assert.equal(saved.pending.length, 1, "one pending switch-back per automation and device");
  assert.equal(saved.pending[0]!.command, "off");
  assert.equal(saved.pending[0]!.due_ms, h.clock.ms + 600_000, "the later trigger sets the time");
  h.engine.close();
});
