// The solar routes of a small wall screen: what they cut down to, who may read, and the one operation on a battery: off by default, the account of a wall panel only, with its PIN at every
// step, the lockout, the duress PIN and the audit. No node that writes to a battery exists here: the order stops at the publication.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseBatteryResult } from "../src/battery_ops.js";
import { PANEL_HISTORY_POINTS, PANEL_MAX_DEVICES, panelDevice, panelDevices, thinHistory } from "../src/panel_solar.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import type { SolarBattery, SolarDeviceView } from "../src/solar.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const SERIAL = "PPTBH00000000001";

const moduleOf = (n: number) => ({ n, present: true, voltage_v: 49.7, current_a: 1.25, temperature_c: 21.5, soc_percent: 76, state: "Charge", cells_v: Array.from({ length: 32 }, () => 3.312),
  temperatures_c: Array.from({ length: 6 }, () => 21.5), capacity_ah: 56.2, full_capacity_ah: 74, cycles: 120, health_percent: 98, board_version: "B1", soft_version: "V3.0", serial: "PRIVATE-SERIAL-0001",
  counters: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`counter_${index}_times`, index])) });
const stack = (device: string, modules: number): SolarBattery => ({ kind: "battery", node_id: "solar-1", device, timestamp_ms: 1, modules, stack: Array.from({ length: modules }, (_, i) => moduleOf(i + 1)),
  voltage_v: 49.7, current_a: 5, soc_percent: 76, cell_min_v: 3.31, cell_max_v: 3.32 }) as unknown as SolarBattery;
const view = (index: number, modules = 16): SolarDeviceView => ({ node_id: "solar-1", device: `pack-${index}`, kind: "battery", reading: stack(`pack-${index}`, modules), received_at: "2030-01-01T00:00:00.000Z", stale: false, example: false });

const count = (value: unknown): number => (Array.isArray(value) ? 1 + value.reduce((sum: number, item) => sum + count(item), 0)
  : typeof value === "object" && value !== null ? 1 + Object.values(value).reduce((sum: number, item) => sum + count(item), 0) : 1);

test("the list of a screen leaves out the modules and stays small even with a full installation", () => {
  const views = Array.from({ length: 40 }, (_, index) => view(index));
  const list = panelDevices(views, (_node, device) => (device === "pack-0" ? "Garage" : undefined));
  assert.equal(list.devices.length, PANEL_MAX_DEVICES);
  assert.equal(list.omitted, 40 - PANEL_MAX_DEVICES);
  assert.equal(list.devices[0].name, "Garage");
  assert.ok(!("stack" in list.devices[0].reading));
  assert.equal(list.devices[0].reading.soc_percent, 76);
  assert.ok(JSON.stringify(list).length < 40_000);
  assert.ok(count(list) < 2_000);
});

test("one device carries its modules and cells, and the biggest stack fits the reader of a node", () => {
  const one = panelDevice(view(1), undefined);
  const modules = one.reading.stack as Array<Record<string, unknown>>;
  assert.equal(modules.length, 16);
  assert.equal((modules[0].cells_v as number[]).length, 32);
  assert.ok("counters" in modules[0]);
  assert.ok(!("board_version" in modules[0]) && !("soft_version" in modules[0]));
  assert.ok(!JSON.stringify(one).includes("PRIVATE-SERIAL"), "a serial number is private: a wall screen is never given it");
  assert.ok(JSON.stringify(one).length < 60_000);
  assert.ok(count(one) < 4_000);
});

test("a wall screen is told who made an inverter, and nothing private of it", () => {
  const inverter = { node_id: "solar-1", device: "inv-1", kind: "inverter", received_at: "2030-01-01T00:00:00.000Z", stale: false, example: false,
    reading: { kind: "inverter", node_id: "solar-1", device: "inv-1", timestamp_ms: 1, mode: "line", pv_w: 10, manufacturer: "Voltronic", manufacturer_source: "deduced", serial: "PRIVATESERIAL001" } } as unknown as SolarDeviceView;
  const shown = panelDevices([inverter], () => undefined).devices[0].reading;
  assert.equal(shown.manufacturer, "Voltronic");
  assert.equal(shown.manufacturer_source, "deduced");
  assert.ok(!("serial" in shown));
});

test("a wall screen is given what the equipment counts", () => {
  const inverter = { node_id: "solar-1", device: "inv-1", kind: "inverter", received_at: "2030-01-01T00:00:00.000Z", stale: false, example: false,
    reading: { kind: "inverter", node_id: "solar-1", device: "inv-1", timestamp_ms: 1, mode: "line", energy: { pv_today_wh: 1200 }, pv_energy_total_wh: 5000, options_on: ["buzzer"] } } as unknown as SolarDeviceView;
  const shown = panelDevices([inverter], () => undefined).devices[0].reading;
  assert.deepEqual(shown.energy, { pv_today_wh: 1200 });
  assert.equal(shown.pv_energy_total_wh, 5000);
  assert.ok(!("options_on" in shown));
  const battery = { ...view(1), reading: { ...stack("pack-1", 1), bms_system: { health_percent: 97 } } } as unknown as SolarDeviceView;
  assert.deepEqual(panelDevices([battery], () => undefined).devices[0].reading.bms_system, { health_percent: 97 });
  assert.deepEqual(panelDevice(battery, undefined).reading.bms_system, { health_percent: 97 });
});

test("a history is thinned evenly and keeps the newest point", () => {
  const samples = Array.from({ length: 1000 }, (_, t) => ({ t }));
  const thin = thinHistory(samples);
  assert.equal(thin.length, PANEL_HISTORY_POINTS);
  assert.equal(thin[thin.length - 1].t, 999);
  assert.ok(thin.every((sample, index) => index === 0 || sample.t > thin[index - 1].t));
  assert.deepEqual(thinHistory(samples.slice(0, 5)), samples.slice(0, 5));
});

test("both options are off by default and turning one on counts as lowering a protection", () => {
  for (const key of ["panel.solar", "solar.panel_battery_ops"] as const) {
    assert.equal(SECURITY_DEFAULTS[key], false, key);
    assert.equal(lowers(key, false, true), true, key);
    assert.equal(lowers(key, true, false), false, key);
  }
});

// ---- the routes ------------------------------------------------------------------------------------------------------------------------------

type Who = { admin: Record<string, string>; panel: Record<string, string>; operator: Record<string, string>; panelId: string };

async function people(running: Running, pin = true): Promise<Who> {
  const json = { "Content-Type": "application/json" };
  const admin = { ...json, cookie: await studioCookie(running.base) };
  const make = async (username: string, role: string) => {
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username, password: `${username}-password-1`, role }) });
    assert.equal(made.status, 201);
    const id = ((await made.json()) as { id: string }).id;
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username, password: `${username}-password-1` }) });
    return { id, headers: { ...json, cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] } };
  };
  const panel = await make("wall-screen", "panel");
  const operator = await make("guard-1", "operator");
  if (pin) assert.equal((await fetch(`${running.base}/api/v1/users/${panel.id}/pin`, { method: "PUT", headers: admin, body: JSON.stringify({ pin: "2468", duress_pin: "1357" }) })).status, 200);
  return { admin, panel: panel.headers, operator: operator.headers, panelId: panel.id };
}

async function turn(running: Running, who: Who, values: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: who.admin, body: JSON.stringify(values) });
  assert.equal(answer.status, 200, await answer.clone().text());
}

async function call(running: Running, headers: Record<string, string>, method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const answer = await fetch(`${running.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: answer.status, body: (await answer.json().catch(() => ({}))) as Record<string, any> };
}

const order = { node: "solar-1", port: 2, serial: SERIAL, pin: "2468" };

test("a wall screen reads the solar equipment only while the option is on", async () => {
  const running = await startServer();
  try {
    const who = await people(running);
    running.app.context.solar.ingest(stack("pack-1", 2));
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar")).status, 403);
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar/devices/solar-1/pack-1")).status, 403);
    assert.equal((await call(running, who.operator, "GET", "/api/v1/panel/solar")).status, 200, "an operator reads it as it reads the whole solar answer");
    await turn(running, who, { "panel.solar": true });
    const list = await call(running, who.panel, "GET", "/api/v1/panel/solar");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.battery_ops, { enabled: false, may: false, operations: ["clear_stats"] });
    assert.equal(list.body.devices.length, 1);
    assert.equal(list.body.totals.batteries, 1);
    const one = await call(running, who.panel, "GET", "/api/v1/panel/solar/devices/solar-1/pack-1");
    assert.ok(![list, one].some(answer => JSON.stringify(answer.body).includes("PRIVATE-SERIAL")), "no serial number leaves by these routes");
    assert.equal(one.body.devices[0].reading.stack.length, 2);
    const history = await call(running, who.panel, "GET", "/api/v1/panel/solar/history?node=solar-1&device=pack-1");
    assert.equal(history.status, 200);
    assert.ok(history.body.samples.length >= 1);
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar/history?node=solar-1&device=nothing")).status, 404);
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar/history")).status, 400);
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar/devices/solar-1/nothing")).status, 404);
    assert.equal((await call(running, who.panel, "GET", "/api/v1/solar")).status, 403, "the whole solar answer stays closed to it");
    assert.equal((await fetch(`${running.base}/api/v1/panel/solar`)).status, 401);
  } finally { await running.stop(); }
});

test("the operation from a wall screen is off by default, needs both options, the panel account and its PIN", async () => {
  const running = await startServer();
  try {
    const who = await people(running);
    running.app.context.solar.ingest(stack("pack-1", 2));
    const post = (headers: Record<string, string>, body: unknown = order) => call(running, headers, "POST", "/api/v1/panel/solar/battery-ops", body);
    // off: the panel account does not get past the guard, and nobody else orders from here
    assert.equal((await post(who.panel)).status, 403);
    assert.equal((await post(who.operator)).body.code, "panel_account_only");
    assert.equal((await post(who.admin)).body.code, "panel_account_only");
    await turn(running, who, { "solar.panel_battery_ops": true });
    assert.equal((await post(who.panel)).body.code, "battery_write_disabled", "the writing to batteries itself is still off");
    await turn(running, who, { "solar.battery_write": true });
    assert.equal((await post(who.panel, { ...order, pin: undefined })).body.code, "pin_required");
    assert.equal((await post(who.panel, { ...order, op: "clear_data" })).body.code, "operation_not_from_panel");
    assert.equal((await post(who.panel, { ...order, pin: "9999" })).body.code, "wrong_pin");
    // the right PIN reaches the service, which finds no broker: nothing was sent
    const sent = await post(who.panel);
    assert.equal(sent.status, 503);
    assert.equal(sent.body.code, "mqtt_unavailable");
    // a broker that takes it: the operation is armed from the screen, and only its owner sees it
    const published: string[] = [];
    running.app.context.batteryLink.publish = (_topic: string, payload: string) => { published.push(payload); };
    const armed = await post(who.panel);
    assert.equal(armed.status, 202);
    assert.deepEqual([armed.body.op, armed.body.stage, armed.body.port], ["clear_stats", "arming", 2]);
    assert.equal(JSON.parse(published[0]).op, "clear_stats");
    assert.equal((await call(running, who.panel, "GET", `/api/v1/panel/solar/battery-ops/${armed.body.id}`)).status, 200);
    assert.equal((await call(running, who.operator, "GET", `/api/v1/panel/solar/battery-ops/${armed.body.id}`)).status, 403);
    // the node says who the battery is; the screen is told the model and never the serial number
    const asked = JSON.parse(published[0]) as { command_id: string };
    running.app.context.batteryWrite.handleResult(parseBatteryResult({ kind: "solar_battery_result", node_id: "solar-1", timestamp_ms: 9, port: 2, accepted: true, refusal: "none", command_id: asked.command_id,
      action: "arm", op: "clear_stats", stage: "armed", token: "0123456789abcdef0123456789abcdef", canonical: "clear_stats", summary: "clear the counters", risk: "medium", atomic: false,
      battery: { model: "US3000C", serial: SERIAL, soft_version: "V3.0", board: "" } }), "solar-1");
    const ready = await call(running, who.panel, "GET", `/api/v1/panel/solar/battery-ops/${armed.body.id}`);
    assert.deepEqual([ready.body.stage, ready.body.battery.model], ["armed", "US3000C"]);
    assert.ok(!JSON.stringify(ready.body).includes(SERIAL) && !JSON.stringify(ready.body).includes("0123456789abcdef0123"), "no serial number and no token");
    assert.equal((await call(running, who.panel, "GET", "/api/v1/panel/solar/battery-ops/0000000000000000")).status, 404);
    // the second step asks the PIN again, and the node has not accepted yet
    const execute = (body: unknown) => call(running, who.panel, "POST", `/api/v1/panel/solar/battery-ops/${armed.body.id}/execute`, body);
    assert.equal((await execute({ serial: SERIAL })).body.code, "pin_required");
    assert.equal((await execute({ serial: SERIAL, pin: "0000" })).body.code, "wrong_pin");
    const executed = await execute({ serial: SERIAL, pin: "2468" });
    assert.deepEqual([executed.status, executed.body.stage], [202, "starting"]);
    assert.ok(!JSON.stringify(executed.body).includes(SERIAL));
    assert.equal((await execute({ serial: SERIAL, pin: "2468" })).body.code, "not_armed", "one arm, one execute");
    const trail = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { action: string; outcome: string; detail?: string });
    assert.ok(trail.filter(event => event.action === "panel.battery_ops" && event.outcome === "denied").length >= 6, "every refusal is in the audit trail");
    assert.ok(trail.filter(event => event.action === "panel.battery_ops").every(event => !/2468|9999|0000/.test(event.detail ?? "")), "a PIN is never written down");
  } finally { await running.stop(); }
});

test("wrong PINs lock the account, and an account without a PIN orders nothing", async () => {
  const running = await startServer();
  try {
    const who = await people(running, false);
    running.app.context.solar.ingest(stack("pack-1", 2));
    await turn(running, who, { "solar.panel_battery_ops": true, "solar.battery_write": true });
    const post = (body: unknown = order) => call(running, who.panel, "POST", "/api/v1/panel/solar/battery-ops", body);
    assert.equal((await post()).body.code, "pin_not_set");
    assert.equal((await fetch(`${running.base}/api/v1/users/${who.panelId}/pin`, { method: "PUT", headers: who.admin, body: JSON.stringify({ pin: "2468" }) })).status, 200);
    const codes: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) codes.push((await post({ ...order, pin: "1111" })).body.code);
    assert.deepEqual(codes, ["wrong_pin", "wrong_pin", "pin_locked", "pin_locked"]);
    const locked = await post();
    assert.equal(locked.status, 429, "the right PIN waits too");
    assert.ok(locked.body.retry_after_s > 0);
  } finally { await running.stop(); }
});

test("the duress PIN lets the order through and raises the silent alarm", async () => {
  const running = await startServer();
  try {
    const who = await people(running);
    running.app.context.solar.ingest(stack("pack-1", 2));
    await turn(running, who, { "solar.panel_battery_ops": true, "solar.battery_write": true });
    running.app.context.batteryLink.publish = () => undefined;
    const before = running.app.context.duressLog.view().count;
    const armed = await call(running, who.panel, "POST", "/api/v1/panel/solar/battery-ops", { ...order, pin: "1357" });
    assert.equal(armed.status, 202);
    assert.equal(running.app.context.duressLog.view().count, before + 1);
  } finally { await running.stop(); }
});
