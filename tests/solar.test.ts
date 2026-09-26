// Solar inverters and batteries: the store, the routes and the alarms they raise.
import assert from "node:assert/strict";
import test from "node:test";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { parseSolarMessage, SolarStore, solarTopic, type SolarBattery, type SolarInverter } from "../src/solar.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";
import { SolarRegistry, slug } from "../src/solar_registry.js";

const inverter = (extra: Partial<SolarInverter> = {}): SolarInverter => ({
  kind: "inverter", node_id: "solar-1", device: "axpert-1", timestamp_ms: 1000, mode: "line", grid_v: 232, grid_hz: 50, out_v: 230, out_hz: 50, out_va: 161, out_w: 119, load_percent: 3,
  battery_v: 57.5, battery_a: 12, battery_percent: 100, pv_v: 103.8, pv_a: 14, pv_w: 856, heatsink_c: 69, ac_charging: false, pv_charging: true, load_on: true, warnings: [], ...extra,
});
const battery = (extra: Partial<SolarBattery> = {}): SolarBattery => ({
  kind: "battery", node_id: "solar-1", device: "us3000-1", timestamp_ms: 3000, modules: 2, state: "discharging", voltage_v: 49.87, current_a: -2.59, temperature_min_c: 19.5,
  temperature_max_c: 25, cell_min_v: 3.328, cell_max_v: 3.349, soc_percent: 88, alarm: false, stack: [{ n: 1, present: true, soc_percent: 88 }, { n: 2, present: false }], ...extra,
});

test("the topic names a node and a device, and nothing else", () => {
  assert.deepEqual(solarTopic("armor/solar/solar-1/axpert-1/state"), ["solar-1", "axpert-1"]);
  for (const topic of ["armor/solar/solar-1/state", "armor/solar/solar-1/axpert-1/set", "armor/node/solar-1/axpert-1/state", "armor/solar/Solar/axpert-1/state", "armor/solar/solar-1/-x/state", "armor/solar/solar-1/axpert-1/state/x"]) {
    assert.equal(solarTopic(topic), undefined, topic);
  }
});

test("the store keeps the latest reading, the sums and a bounded history", () => {
  let now = 1_000_000;
  const store = new SolarStore({ now: () => now, sampleEveryMs: 30_000, keepSamples: 3 });
  store.ingest(inverter());
  store.ingest(battery());
  const totals = store.totals();
  assert.deepEqual([totals.inverters, totals.batteries, totals.pv_w, totals.load_w, totals.grid_present, totals.mode], [1, 1, 856, 119, true, "line"]);
  assert.equal(totals.soc_percent, 88);                 // the stack's own charge is preferred to the inverter's
  assert.equal(totals.battery_w, Math.round(49.87 * -2.59));
  assert.deepEqual(store.list().map(entry => [entry.kind, entry.device, entry.stale]), [["inverter", "axpert-1", false], ["battery", "us3000-1", false]]);
  // history: one sample per interval, the oldest dropped beyond the limit, `minutes` bounds how far back
  for (let i = 0; i < 6; i += 1) { now += 31_000; store.ingest(inverter({ pv_w: 100 * (i + 1) })); }
  const history = store.history("solar-1", "axpert-1", 1440);
  assert.equal(history?.samples.length, 3);
  assert.deepEqual(history?.samples.map(sample => sample.pv_w), [400, 500, 600]);
  assert.equal(store.history("solar-1", "axpert-1", 1)?.samples.length, 2);   // the last minute holds the last two (31 s apart)
  assert.equal(store.history("solar-1", "nobody", 60), undefined);
  // with no stack the inverter's battery numbers stand in
  const alone = new SolarStore({ now: () => now });
  alone.ingest(inverter({ battery_percent: 40, battery_v: 50, battery_a: -10 }));
  assert.deepEqual([alone.totals().soc_percent, alone.totals().battery_w], [40, -500]);
  assert.deepEqual([new SolarStore().totals().soc_percent, new SolarStore().totals().battery_w, new SolarStore().totals().mode], [null, null, null]);
});

test("a device that goes quiet is stale, is left out of the sums, and is announced both ways", () => {
  let now = 0;
  const told: string[] = [];
  const store = new SolarStore({ now: () => now, staleAfterMs: 60_000, onStale: (node, device, stale) => told.push(`${node}/${device}:${stale}`) });
  store.ingest(inverter());
  now += 59_000; store.sweep();
  assert.deepEqual(told, []);
  now += 2_000; store.sweep();
  assert.deepEqual(told, ["solar-1/axpert-1:true"]);
  assert.equal(store.totals().pv_w, 0);
  assert.equal(store.list()[0].stale, true);
  store.sweep();
  assert.deepEqual(told, ["solar-1/axpert-1:true"]);                     // said once
  store.ingest(inverter());
  assert.deepEqual(told, ["solar-1/axpert-1:true", "solar-1/axpert-1:false"]);
  assert.equal(store.totals().pv_w, 856);
});

test("the store refuses a new device beyond its limit, but keeps updating the ones it has", () => {
  const store = new SolarStore({ maxDevices: 2 });
  store.ingest(inverter({ device: "a" })); store.ingest(inverter({ device: "b" }));
  assert.throws(() => store.ingest(inverter({ device: "c" })), /too many/);
  assert.doesNotThrow(() => store.ingest(inverter({ device: "a", pv_w: 5 })));
});

test("the parser is strict: a missing, unknown or out-of-range field is refused", () => {
  assert.deepEqual(parseSolarMessage(inverter()), inverter());
  assert.deepEqual(parseSolarMessage(battery()), battery());
  const { soc_percent: _omitted, ...withoutCharge } = battery();
  assert.doesNotThrow(() => parseSolarMessage(withoutCharge));
  for (const bad of [{ ...inverter(), extra: 1 }, { ...inverter(), mode: "sleeping" }, { ...inverter(), pv_w: -1 }, { ...inverter(), battery_percent: 101 }, { ...inverter(), warnings: ["Line fail"] },
    { ...inverter(), device: "Axpert" }, { ...battery(), modules: 17 }, { ...battery(), soc_percent: null }, { ...battery(), state: "full" }, { ...battery(), stack: [{ n: 0, present: true }] }, { kind: "toaster" }, 5]) {
    assert.throws(() => parseSolarMessage(bad), JSON.stringify(bad).slice(0, 60));
  }
});

test("the alarms: a fault, a low battery with a recovery level, a stack that reports an alarm, and a silent device", () => {
  const dir = tempDir();
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");        // solar alarms do not depend on the security mode
  const codes = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => alarm.code).sort();
  rules.handleSolar(inverter());
  assert.deepEqual(codes(), []);
  rules.handleSolar(inverter({ warnings: ["line_fail"] }));      // a warning that is not a fault
  assert.deepEqual(codes(), []);
  rules.handleSolar(inverter({ mode: "fault" }));
  assert.deepEqual(codes(), ["solar_fault"]);
  rules.handleSolar(inverter({ warnings: ["over_temperature"] }));
  assert.deepEqual(codes(), ["solar_fault"]);                     // still the same alarm
  rules.handleSolar(inverter());
  assert.deepEqual(codes(), []);                                  // the cause ended
  rules.handleSolar(inverter({ battery_percent: 19 }));
  assert.deepEqual(codes(), ["solar_battery_low"]);
  rules.handleSolar(inverter({ battery_percent: 25 }));
  assert.deepEqual(codes(), ["solar_battery_low"]);               // not yet above the recovery level
  rules.handleSolar(inverter({ battery_percent: 30 }));
  assert.deepEqual(codes(), []);
  rules.handleSolar(battery({ alarm: true }));
  assert.deepEqual(codes(), ["solar_battery_alarm"]);
  rules.handleSolar(battery({ alarm: false, soc_percent: 10 }));
  assert.deepEqual(codes(), ["solar_battery_low"]);
  rules.handleSolar(battery({ modules: 0, stack: [], alarm: undefined, soc_percent: undefined }));
  assert.deepEqual(codes(), ["solar_battery_low"]);               // a stack that does not answer says nothing about its charge
  rules.handleSolarStale("solar-1", "axpert-1", true);
  assert.deepEqual(codes(), ["solar_battery_low", "solar_offline"]);
  rules.handleSolarStale("solar-1", "axpert-1", false);
  assert.deepEqual(codes(), ["solar_battery_low"]);
  assert.deepEqual(centre.active().filter(alarm => !alarm.cleared_at).map(alarm => alarm.source.type), ["solar"]);
});

test("the routes: a node posts with the ingest token, an operator reads, the history validates its questions", async () => {
  const running = await startServer();
  try {
    const post = (body: unknown, token?: string) => fetch(`${running.base}/api/v1/solar`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post(inverter())).status, 401);
    assert.equal((await post(inverter(), "x".repeat(32))).status, 401);
    assert.equal((await post({ ...inverter(), mode: "sleeping" }, SECRETS.ARMOR_INGEST_TOKEN)).status, 400);
    for (const message of [inverter(), battery()]) {
      const answer = await post(message, SECRETS.ARMOR_INGEST_TOKEN);
      assert.equal(answer.status, 202, await answer.text());
    }
    assert.equal((await fetch(`${running.base}/api/v1/solar`)).status, 401);
    const cookie = await studioCookie(running.base);
    const list = await (await fetch(`${running.base}/api/v1/solar`, { headers: { cookie } })).json() as { devices: Array<{ device: string; stale: boolean }>; totals: { pv_w: number; soc_percent: number } };
    assert.deepEqual(list.devices.map(d => d.device), ["axpert-1", "us3000-1"]);
    assert.deepEqual([list.totals.pv_w, list.totals.soc_percent], [856, 88]);
    const history = (query: string) => fetch(`${running.base}/api/v1/solar/history${query}`, { headers: { cookie } });
    assert.equal((await history("")).status, 400);
    assert.equal((await history("?node=Solar&device=x")).status, 400);
    assert.equal((await history("?node=solar-1&device=nobody")).status, 404);
    const ok = await (await history("?node=solar-1&device=axpert-1&minutes=99999")).json() as { minutes: number; kind: string; samples: unknown[] };
    assert.deepEqual([ok.kind, ok.minutes, ok.samples.length], ["inverter", 1440, 1]);
    assert.equal((await fetch(`${running.base}/api/v1/solar/history?node=solar-1&device=axpert-1`)).status, 401);
  } finally { await running.stop(); }
});

test("a stack with cells, capacities, a model and cycles is kept whole and its capacities are summed", () => {
  const detailed = battery({
    model: "US3000C", capacity_ah: 125.1, full_capacity_ah: 148, energy_kwh: 6.24, cycles: 340,
    stack: [
      { n: 1, present: true, soc_percent: 88, capacity_ah: 65.1, full_capacity_ah: 74, cycles: 312, cells_v: [3.324, 3.325, 3.323, 3.33, 3.329, 3.326, 3.327, 3.325, 3.324, 3.348, 3.326, 3.325, 3.324, 3.327, 3.326], temperatures_c: [22, 22.5, 23] },
      { n: 2, present: true, capacity_ah: 60, full_capacity_ah: 74, cycles: 340 },
    ],
  });
  const parsed = parseSolarMessage(detailed) as SolarBattery;
  assert.equal(parsed.stack[0].cells_v?.length, 15);
  assert.deepEqual(parsed.stack[0].temperatures_c, [22, 22.5, 23]);
  const store = new SolarStore();
  store.ingest(parsed);
  store.ingest(battery({ device: "us3000-2", capacity_ah: 50, full_capacity_ah: 74, energy_kwh: 2.5 }));
  const totals = store.totals();
  assert.deepEqual([totals.capacity_ah, totals.full_capacity_ah, totals.energy_kwh], [175.1, 222, 8.74]);
  assert.equal(new SolarStore().totals().capacity_ah, null);
  for (const bad of [{ ...detailed, model: "" }, { ...detailed, cycles: 1.5 }, { ...detailed, capacity_ah: -1 }, { ...detailed, stack: [{ n: 1, present: true, cells_v: Array(33).fill(3.3) }] },
    { ...detailed, stack: [{ n: 1, present: true, cells_v: [10.5] }] }, { ...detailed, stack: [{ n: 1, present: true, temperatures_c: Array(9).fill(20) }] }]) {
    assert.throws(() => parseSolarMessage(bad));
  }
  const samples = store.history("solar-1", "us3000-1", 60)?.samples ?? [];
  assert.equal(samples[0].energy_kwh, 6.24);
});

test("an operator declares solar equipment, it waits for its first reading, an example fills it in and a real reading replaces the example", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const json = { "Content-Type": "application/json", cookie };
    const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = json) => fetch(`${running.base}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(`${running.base}/api/v1/solar/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    // declared: it shows as waiting, and the identifier comes from the name
    const created = await call("POST", "/api/v1/solar/devices", { kind: "battery", name: "Baterías del garaje", node_id: "solar-1", model: "pylontech-us3000", connection: "rs485" });
    assert.equal(created.status, 201);
    const registration = await created.json() as { device: string; model: string };
    assert.deepEqual([registration.device, registration.model], ["baterias-del-garaje", "pylontech-us3000"]);
    const before = await (await call("GET", "/api/v1/solar")).json() as { devices: unknown[]; waiting: Array<{ device: string }>; catalog: { battery_models: string[] } };
    assert.deepEqual([before.devices.length, before.waiting.map(item => item.device)], [0, ["baterias-del-garaje"]]);
    assert.ok(before.catalog.battery_models.includes("ant-bms"));
    // wrong input is refused, and the same node and device cannot change kind
    for (const bad of [{ kind: "toaster", name: "x", node_id: "solar-1" }, { kind: "battery", name: "", node_id: "solar-1" }, { kind: "battery", name: "x", node_id: "Bad Node" }, { kind: "battery", name: "x", node_id: "solar-1", model: "axpert" }]) {
      assert.equal((await call("POST", "/api/v1/solar/devices", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call("POST", "/api/v1/solar/devices", { kind: "inverter", name: "x", node_id: "solar-1", device: "baterias-del-garaje" })).status, 409);
    // an example reading: the device leaves the waiting list, is marked as an example, has its cells and capacities, and raises no alarm
    assert.equal((await call("POST", "/api/v1/solar/devices/solar-1/nobody/example")).status, 404);
    assert.equal((await call("POST", "/api/v1/solar/devices/solar-1/baterias-del-garaje/example")).status, 202);
    const after = await (await call("GET", "/api/v1/solar")).json() as { devices: Array<{ example: boolean; registered?: { name: string }; reading: { stack: Array<{ cells_v: number[] }>; capacity_ah: number; full_capacity_ah: number } }>; waiting: unknown[] };
    assert.equal(after.waiting.length, 0);
    assert.deepEqual([after.devices[0].example, after.devices[0].registered?.name, after.devices[0].reading.stack.length, after.devices[0].reading.stack[0].cells_v.length, after.devices[0].reading.full_capacity_ah], [true, "Baterías del garaje", 2, 15, 148]);
    // the first real reading replaces the example
    const real = await fetch(`${running.base}/api/v1/solar`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(battery({ device: "baterias-del-garaje" })) });
    assert.equal(real.status, 202);
    const replaced = await (await call("GET", "/api/v1/solar")).json() as { devices: Array<{ example: boolean }> };
    assert.equal(replaced.devices[0].example, false);
    // removing it forgets the declaration and the reading
    assert.equal((await call("DELETE", "/api/v1/solar/devices/solar-1/baterias-del-garaje")).status, 204);
    assert.equal((await call("DELETE", "/api/v1/solar/devices/solar-1/baterias-del-garaje")).status, 404);
    const gone = await (await call("GET", "/api/v1/solar")).json() as { devices: unknown[]; waiting: unknown[] };
    assert.deepEqual([gone.devices.length, gone.waiting.length], [0, 0]);
  } finally { await running.stop(); }
});

test("the registry survives a restart and ignores a damaged file", () => {
  const directory = tempDir();
  const file = path.join(directory, "solar-devices.json");
  const first = new SolarRegistry(file);
  first.save({ kind: "inverter", name: "Axpert 5 kW", node_id: "solar-1", model: "voltronic", connection: "rs232", notes: "roof" });
  assert.deepEqual(new SolarRegistry(file).list().map(item => [item.device, item.model, item.notes]), [["axpert-5-kw", "voltronic", "roof"]]);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(new SolarRegistry(file).list(), []);
  assert.equal(slug("  Ñandú / Casa 2 "), "nandu-casa-2");
});
