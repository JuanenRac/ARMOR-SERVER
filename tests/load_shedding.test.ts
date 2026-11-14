import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SHEDDING, LoadShedding, MIN_GAP_W, SheddingInvalid, parseSheddingSettings } from "../src/load_shedding.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

type Bench = ReturnType<typeof build>;
/** A house with a simulated load: the grid draw is the base draw plus what each device that is on takes. */
function build(options: { enabled?: boolean; base?: number; loads?: Record<string, number>; critical?: string[]; unknown?: string[]; fail?: string[] } = {}) {
  const loads = options.loads ?? { heater: 2000, boiler: 1500, washer: 800 };
  const on = new Map(Object.keys(loads).map(id => [id, true]));
  const calls: string[] = [];
  let clock = 1_000_000;
  let enabled = options.enabled ?? true;
  let base = options.base ?? 1000;
  let gridReading: number | null | "simulated" = "simulated";
  const grid = (): number => base + [...on].filter(([, state]) => state).reduce((sum, [id]) => sum + loads[id], 0);
  const events: string[] = [];
  const service = new LoadShedding({
    file: path.join(tempDir(), "load-shedding.json"), enabled: () => enabled, now: () => clock,
    gridW: () => (gridReading === "simulated" ? grid() : gridReading),
    device: id => (options.unknown?.includes(id) || !(id in loads) ? { exists: false, critical: false } : { exists: true, critical: Boolean(options.critical?.includes(id)) }),
    command: async (id, command) => { if (options.fail?.includes(id)) throw new Error("plug does not answer"); calls.push(`${id}=${command}`); on.set(id, command === "on"); },
    onEvent: entry => { events.push(`${entry.action}:${entry.device}`); },
  });
  service.configure({ limit_w: 4000, restore_w: 3000, hold_s: 30, step_s: 20, loads: Object.keys(loads) });
  /** Runs the clock for `seconds`, one tick a second, and returns what was done. */
  const run = async (seconds: number): Promise<string[]> => { const done: string[] = []; for (let index = 0; index < seconds; index += 1) { clock += 1000; const result = await service.tick(); if (result) done.push(result); } return done; };
  return { service, calls, events, run, on, setBase: (value: number) => { base = value; }, setEnabled: (value: boolean) => { enabled = value; }, setReading: (value: number | null | "simulated") => { gridReading = value; }, grid };
}
void (null as unknown as Bench);

test("the option is off by default and shedding is not a way in", () => {
  assert.equal(SECURITY_DEFAULTS["electrical.load_shedding"], false);
  assert.equal(lowers("electrical.load_shedding", false, true), false);
});

test("the settings are checked: ranges, a gap for the hysteresis, a short list of different device ids, no unknown keys", () => {
  assert.deepEqual(parseSheddingSettings({}), DEFAULT_SHEDDING);
  for (const bad of [{ limit_w: 100 }, { limit_w: 1.5 }, { hold_s: 1 }, { step_s: 4000 }, { restore_w: 5000 }, { limit_w: 3000, restore_w: 2950 }, { loads: "heater" }, { loads: ["a", "a"] }, { loads: ["has space"] },
    { loads: Array.from({ length: 17 }, (_, index) => `d${index}`) }, { surprise: 1 }, [], null]) assert.throws(() => parseSheddingSettings(bad), SheddingInvalid, JSON.stringify(bad));
  assert.equal(parseSheddingSettings({ limit_w: 2000, restore_w: 2000 - MIN_GAP_W }).restore_w, 1900);
});

test("over the limit for long enough, loads are shed one at a time in the order of the list, until the draw is under the limit", async () => {
  const b = build();          // base 1000 + 2000 + 1500 + 800 = 5300 W, limit 4000
  assert.deepEqual(await b.run(29), [], "not yet: the draw must hold for 30 s");
  assert.deepEqual(await b.run(2), ["shed"]);
  assert.deepEqual(b.calls, ["heater=off"]);
  assert.equal(b.grid(), 3300, "now under the limit");
  assert.deepEqual(await b.run(60), [], "and nothing more is shed once it is");
  assert.deepEqual(b.service.status().shed, ["heater"]);
});

test("a second load is shed only after the step time, and only while the draw stays over the limit", async () => {
  const b = build({ base: 3500 });      // 3500 + 4300 = 7800
  assert.deepEqual(await b.run(31), ["shed"]);
  assert.deepEqual(await b.run(10), [], "less than 20 s since the last action");
  assert.deepEqual(await b.run(12), ["shed"]);
  assert.deepEqual(b.calls, ["heater=off", "boiler=off"]);
});

test("a draw that goes under the limit before the hold time resets the timer: a short peak sheds nothing", async () => {
  const b = build();
  await b.run(20);
  b.setBase(-2000);
  await b.run(5);
  b.setBase(1000);
  assert.deepEqual(await b.run(25), [], "the clock started again");
  assert.deepEqual(b.calls, []);
});

test("loads come back in the opposite order once the draw is below the restore level for the hold time, one per step", async () => {
  const b = build({ base: 3500 });
  await b.run(31); await b.run(21);      // heater and boiler shed
  assert.deepEqual(b.service.status().shed, ["heater", "boiler"]);
  b.setBase(100);                          // 100 + 800 = 900 W while both are off
  assert.deepEqual(await b.run(25), [], "below the restore level but not for 30 s yet");
  assert.deepEqual(await b.run(10), ["restore"]);
  assert.equal(b.calls.at(-1), "boiler=on", "the last shed comes back first");
  assert.deepEqual(b.service.status().shed, ["heater"]);
  assert.deepEqual(await b.run(30), ["restore"]);
  assert.equal(b.calls.at(-1), "heater=on");
  assert.deepEqual(b.service.status().shed, []);
});

test("between the restore level and the limit nothing happens, so a load is not switched on and off over and over", async () => {
  const b = build();
  await b.run(31);                         // heater shed, 3300 W: between 3000 and 4000
  assert.deepEqual(await b.run(300), []);
  assert.deepEqual(b.calls, ["heater=off"]);
});

test("it only touches the devices in the list, never a critical circuit, and says once when it refuses one", async () => {
  const b = build({ critical: ["heater"], unknown: ["boiler"] });
  await b.run(31);
  assert.deepEqual(b.calls, ["washer=off"], "the heater is critical, the boiler is unknown: the washer is shed");
  assert.deepEqual(b.events.filter(item => item.startsWith("refused")), ["refused:heater", "refused:boiler"]);
  await b.run(100);
  assert.equal(b.events.filter(item => item.startsWith("refused")).length, 2, "one line each, not one a second");
  const listOnly = build({ loads: { heater: 2000, other: 4000 } });
  listOnly.service.configure({ loads: ["heater"] });
  await listOnly.run(31);
  assert.deepEqual(listOnly.calls, ["heater=off"]);
  await listOnly.run(100);
  assert.deepEqual(listOnly.calls, ["heater=off"], "the other device is never touched");
});

test("with the option off nothing is shed, and turning it off switches back on what was shed", async () => {
  const off = build({ enabled: false });
  assert.deepEqual(await off.run(120), []);
  assert.deepEqual(off.calls, []);
  const b = build({ base: 3500 });
  await b.run(31); await b.run(21);
  assert.equal(b.service.status().shed.length, 2);
  b.setEnabled(false);
  assert.deepEqual(await b.run(1), ["released"]);
  assert.deepEqual(b.calls.slice(-2), ["boiler=on", "heater=on"]);
  assert.deepEqual(b.service.status().shed, []);
  assert.ok(b.events.includes("released:boiler"));
});

test("a load that leaves the list is switched back on; a reading that is missing does nothing", async () => {
  const b = build({ base: 3500 });
  await b.run(31);
  assert.deepEqual(b.service.status().shed, ["heater"]);
  b.service.configure({ loads: ["boiler", "washer"] });
  assert.deepEqual(await b.run(1), ["restore"]);
  assert.equal(b.calls.at(-1), "heater=on");
  b.setReading(null);
  const before = b.calls.length;
  assert.deepEqual(await b.run(120), []);
  assert.equal(b.calls.length, before);
});

test("a device that does not answer is logged as failed, is not counted as shed, and the next device is not tried in the same step", async () => {
  const b = build({ fail: ["heater"] });
  assert.deepEqual(await b.run(31), []);
  assert.deepEqual(b.service.status().shed, []);
  assert.ok(b.events.includes("failed:heater"));
  assert.equal(b.calls.length, 0);
});

test("the state survives a restart: what was shed is still known, and is switched back on later", async () => {
  const file = path.join(tempDir(), "load-shedding.json");
  const first = new LoadShedding({ file, enabled: () => true, gridW: () => 9000, device: () => ({ exists: true, critical: false }), command: async () => undefined, now: (() => { let clock = 0; return () => (clock += 1000); })() });
  first.configure({ loads: ["heater"] });
  for (let index = 0; index < 40; index += 1) await first.tick();
  assert.deepEqual(first.status().shed, ["heater"]);
  const second = new LoadShedding({ file, enabled: () => true, gridW: () => 100, device: () => ({ exists: true, critical: false }), command: async () => undefined, now: (() => { let clock = 10_000_000; return () => (clock += 1000); })() });
  assert.deepEqual(second.status().shed, ["heater"]);
  assert.equal(second.settings.loads[0], "heater");
  let restored = "";
  for (let index = 0; index < 40 && restored === ""; index += 1) restored = (await second.tick()) ?? "";
  assert.equal(restored, "restore");
});

test("the routes: anybody who may operate reads, only an administrator writes, and a bad body is refused", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const json = { "content-type": "application/json", cookie: admin };
    assert.equal((await fetch(`${running.base}/api/v1/electrical/load-shedding`)).status, 401);
    const first = await (await fetch(`${running.base}/api/v1/electrical/load-shedding`, { headers: json })).json() as { enabled: boolean; settings: { loads: string[] }; shed: string[]; log: unknown[] };
    assert.deepEqual({ enabled: first.enabled, loads: first.settings.loads, shed: first.shed, log: first.log }, { enabled: false, loads: [], shed: [], log: [] });
    const saved = await fetch(`${running.base}/api/v1/electrical/load-shedding`, { method: "PUT", headers: json, body: JSON.stringify({ limit_w: 3000, restore_w: 2000, loads: ["heater"] }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as { settings: { loads: string[] } }).settings.loads, ["heater"]);
    const bad = await fetch(`${running.base}/api/v1/electrical/load-shedding`, { method: "PUT", headers: json, body: JSON.stringify({ restore_w: 2999, limit_w: 3000 }) });
    assert.equal(bad.status, 422);
    assert.equal(((await bad.json()) as { code: string }).code, "invalid_settings");
  } finally { await running.stop(); }
});
