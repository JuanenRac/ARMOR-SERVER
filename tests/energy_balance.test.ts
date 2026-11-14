import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ALARM_CODE_WORDS } from "../src/alarm_codes.js";
import { ALERT_LANGUAGES } from "../src/alert_text.js";
import { BalanceInvalid, BalanceWatcher, DEFAULT_BALANCE, MAX_WATCH, applianceStopped, balanceOf, parseBalanceSettings, phaseDown, standbyHigh, type BalanceFinding, type BalanceInput, type PowerSample } from "../src/energy_balance.js";
import { SDM_REGISTERS, SimulatedSdm, decodeSdm, floatOf, registersOf, sdmChannel } from "../src/sdm_meter.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const HOUR = 3_600_000;

test("the option is off by default and the balance only informs", () => {
  assert.equal(SECURITY_DEFAULTS["electrical.balance"], false);
  assert.equal(lowers("electrical.balance", false, true), false);
});

test("the new alarm codes have words in the eight languages", () => {
  for (const code of ["grid_export_unexpected", "meter_mismatch", "consumption_appliance_stopped", "consumption_standby_high", "consumption_phase_down"]) {
    for (const language of ALERT_LANGUAGES) assert.ok(ALARM_CODE_WORDS[code]?.[language]?.length > 8, `${code} ${language}`);
  }
});

test("the balance: consumption is production plus draw minus battery charge, and export, import, self-consumption and autarky follow", () => {
  assert.deepEqual(balanceOf({ production_w: 3000, battery_w: 500, grid_w: -1000, load_w: 1500 }),
    { production_w: 3000, consumption_w: 1500, import_w: 0, export_w: 1000, battery_charge_w: 500, self_consumption_pct: 66.7, autarky_pct: 100, reported_load_w: 1500 });
  const night = balanceOf({ production_w: 0, battery_w: -200, grid_w: 300, load_w: null });
  assert.equal(night.consumption_w, 500);
  assert.equal(night.import_w, 300);
  assert.equal(night.autarky_pct, 40);
  assert.equal(night.self_consumption_pct, null, "nothing was produced: no ratio");
  const blind = balanceOf({ production_w: 2000, battery_w: null, grid_w: null, load_w: 900 });
  assert.deepEqual([blind.consumption_w, blind.import_w, blind.export_w, blind.autarky_pct, blind.self_consumption_pct], [null, null, null, null, null], "without the grid meter nothing is guessed");
  assert.equal(balanceOf({ production_w: 100, battery_w: 0, grid_w: -400, load_w: null }).consumption_w, 0, "never below zero");
});

test("the settings are checked: whole numbers in range, a boolean, a short list of node/channel names", () => {
  assert.deepEqual(parseBalanceSettings({}), DEFAULT_BALANCE);
  for (const bad of [{ export_alert_w: 5 }, { hold_s: 5 }, { mismatch_pct: 95 }, { stopped_h: 0 }, { stopped_h: 1.5 }, { allow_export: "no" }, { watch_channels: ["fridge"] }, { watch_channels: ["a/b", "a/b"] },
    { watch_channels: Array.from({ length: MAX_WATCH + 1 }, (_, index) => `n/c${index}`) }, { surprise: 1 }, [], null]) assert.throws(() => parseBalanceSettings(bad), BalanceInvalid, JSON.stringify(bad));
  assert.deepEqual(parseBalanceSettings({ watch_channels: ["electrical-1/fridge"] }).watch_channels, ["electrical-1/fridge"]);
});

const series = (now: number, hours: number, power: (hoursAgo: number) => number, everyMin = 10): PowerSample[] =>
  Array.from({ length: Math.floor((hours * 60) / everyMin) + 1 }, (_, index) => { const t = now - hours * HOUR + index * everyMin * 60_000; return { t, power_w: power((now - t) / HOUR) }; });

test("an appliance that was working and has been flat at zero for hours is found; one that never worked, or only paused, is not", () => {
  const now = 100 * HOUR;
  const cycling = (ago: number): number => (Math.floor(ago * 3) % 2 === 0 ? 90 : 3);
  assert.equal(applianceStopped(series(now, 24, ago => (ago < 7 ? 0 : cycling(ago))), now, 6), true);
  assert.equal(applianceStopped(series(now, 24, ago => (ago < 2 ? 0 : cycling(ago))), now, 6), false, "off for two hours is a pause");
  assert.equal(applianceStopped(series(now, 24, () => 1), now, 6), false, "it never drew power");
  assert.equal(applianceStopped(series(now, 24, ago => (ago < 7 ? 0 : 90)).slice(-4), now, 6), false, "too little history");
  assert.equal(applianceStopped([], now, 6), false);
});

test("a night standby that rose is found; a steady one, or too little history, is not", () => {
  const now = 100 * HOUR;
  assert.deepEqual(standbyHigh(series(now, 30, ago => (ago <= 3 ? 180 : 60 + (Math.floor(ago * 5) % 3) * 400)), now), { recent_min_w: 180, baseline_w: 60 });
  assert.equal(standbyHigh(series(now, 30, ago => (ago <= 3 ? 70 : 60 + (Math.floor(ago * 5) % 3) * 400)), now), null);
  assert.equal(standbyHigh(series(now, 5, () => 400), now), null, "five hours is not enough to know the usual");
});

test("a phase whose voltage fell to under half of the others' is found, only on a node whose other phases are at mains level", () => {
  assert.deepEqual(phaseDown([{ id: "L1", voltage_v: 231 }, { id: "L2", voltage_v: 80 }, { id: "L3", voltage_v: 229 }]), ["L2"]);
  assert.deepEqual(phaseDown([{ id: "L1", voltage_v: 231 }, { id: "L2", voltage_v: 228 }, { id: "L3", voltage_v: 229 }]), []);
  assert.deepEqual(phaseDown([{ id: "grid", voltage_v: 10 }, { id: "pump", voltage_v: 230 }]), [], "channels that are not phases");
  assert.deepEqual(phaseDown([{ id: "L1", voltage_v: 5 }, { id: "L2", voltage_v: 6 }, { id: "L3", voltage_v: 4 }]), [], "all three down is a blackout, not a phase");
  assert.deepEqual(phaseDown([{ id: "L1", voltage_v: 231 }]), []);
});

function watcher(options: { enabled?: boolean; settings?: Record<string, unknown> } = {}) {
  let clock = 100 * HOUR;
  let enabled = options.enabled ?? true;
  let inputs: BalanceInput = { production_w: 0, battery_w: 0, grid_w: 200, load_w: 200 };
  const reports: string[] = [];
  let history: PowerSample[] | undefined;
  let nodes: Array<{ node_id: string; channels: Array<{ id: string; voltage_v?: number }> }> = [];
  const w = new BalanceWatcher({
    file: path.join(tempDir(), "energy-balance.json"), enabled: () => enabled, now: () => clock, inputs: () => inputs, history: () => history, nodes: () => nodes,
    report: (finding: BalanceFinding, active: boolean) => { reports.push(`${active ? "raise" : "clear"}:${finding.code}:${finding.source}`); },
  });
  if (options.settings) w.configure(options.settings);
  const run = (seconds: number): void => { for (let index = 0; index < seconds; index += 1) { clock += 1000; w.tick(); } };
  return { w, reports, run, set: (value: BalanceInput) => { inputs = value; }, setHistory: (value: PowerSample[] | undefined) => { history = value; }, setNodes: (value: typeof nodes) => { nodes = value; }, setEnabled: (value: boolean) => { enabled = value; }, now: () => clock };
}

test("an export that the installation must not make is told after the hold time and ends when it stops; an installation that may export is left alone", () => {
  const b = watcher({ settings: { allow_export: false, export_alert_w: 300, hold_s: 60 } });
  b.set({ production_w: 3000, battery_w: 0, grid_w: -800, load_w: 2200 });
  b.run(59);
  assert.deepEqual(b.reports, []);
  b.run(2);
  assert.deepEqual(b.reports, ["raise:grid_export_unexpected:grid"]);
  b.run(100);
  assert.equal(b.reports.length, 1, "told once while it lasts");
  b.set({ production_w: 3000, battery_w: 0, grid_w: -100, load_w: 2900 });
  b.run(1);
  assert.deepEqual(b.reports.slice(1), ["clear:grid_export_unexpected:grid"]);
  const allowed = watcher({ settings: { allow_export: true, hold_s: 10 } });
  allowed.set({ production_w: 3000, battery_w: 0, grid_w: -2000, load_w: 1000 });
  allowed.run(60);
  assert.deepEqual(allowed.reports, []);
});

test("meters that disagree for long enough are told; a small difference or a short one is not", () => {
  const b = watcher({ settings: { hold_s: 30, mismatch_pct: 40, mismatch_min_w: 500 } });
  b.set({ production_w: 2000, battery_w: 0, grid_w: 1000, load_w: 3000 });          // worked 3000, reported 3000
  b.run(60);
  assert.deepEqual(b.reports, []);
  b.set({ production_w: 2000, battery_w: 0, grid_w: 1000, load_w: 1200 });          // worked 3000, reported 1200: off by 1800 (60 %)
  b.run(20);
  assert.deepEqual(b.reports, []);
  b.run(15);
  assert.deepEqual(b.reports, ["raise:meter_mismatch:meters"]);
  b.set({ production_w: 100, battery_w: 0, grid_w: 100, load_w: 400 });             // off by 200 W: under the minimum
  b.run(1);
  assert.equal(b.reports.at(-1), "clear:meter_mismatch:meters");
});

test("the history of the watched channels is looked at once a minute, and a phase that is down is told and cleared", () => {
  const b = watcher({ settings: { watch_channels: ["electrical-1/fridge"], stopped_h: 6 } });
  const now = b.now();
  b.setHistory(series(now + 61_000, 24, ago => (ago < 7 ? 0 : (Math.floor(ago * 3) % 2 === 0 ? 90 : 3))));
  b.run(70);
  assert.ok(b.reports.includes("raise:consumption_appliance_stopped:electrical-1/fridge"), b.reports.join());
  b.setHistory(series(b.now() + 61_000, 24, ago => (Math.floor(ago * 3) % 2 === 0 ? 90 : 3)));
  b.run(70);
  assert.ok(b.reports.includes("clear:consumption_appliance_stopped:electrical-1/fridge"));
  b.setNodes([{ node_id: "meter-3", channels: [{ id: "L1", voltage_v: 230 }, { id: "L2", voltage_v: 60 }, { id: "L3", voltage_v: 231 }] }]);
  b.run(70);
  assert.ok(b.reports.includes("raise:consumption_phase_down:meter-3/L2"));
  b.setNodes([{ node_id: "meter-3", channels: [{ id: "L1", voltage_v: 230 }, { id: "L2", voltage_v: 229 }, { id: "L3", voltage_v: 231 }] }]);
  b.run(70);
  assert.ok(b.reports.includes("clear:consumption_phase_down:meter-3/L2"));
});

test("with the option off nothing is watched, and turning it off ends what was open", () => {
  const off = watcher({ enabled: false, settings: { allow_export: false, hold_s: 10 } });
  off.set({ production_w: 3000, battery_w: 0, grid_w: -2000, load_w: 1000 });
  off.run(60);
  assert.deepEqual(off.reports, []);
  const b = watcher({ settings: { allow_export: false, hold_s: 10 } });
  b.set({ production_w: 3000, battery_w: 0, grid_w: -2000, load_w: 1000 });
  b.run(20);
  assert.equal(b.reports.length, 1);
  b.setEnabled(false);
  b.run(1);
  assert.equal(b.reports.at(-1), "clear:grid_export_unexpected:grid");
});

test("the simulated SDM meter answers the registers of a real one and the decoder reads them, with the sign of the power", () => {
  assert.deepEqual(registersOf(230.5), [0x4366, 0x8000]);
  assert.equal(floatOf(0x4366, 0x8000), 230.5);
  const meter = new SimulatedSdm();
  meter.setPower(1500);
  const draw = decodeSdm(meter.registers());
  assert.equal(Math.round(draw.active_power_w), 1500);
  assert.equal(Math.round(draw.voltage_v), 230);
  assert.ok(Math.abs(draw.current_a - 1500 / 0.98 / 230) < 0.01);
  assert.equal(draw.frequency_hz, 50);
  meter.setPower(-2400);
  const feed = decodeSdm(meter.registers());
  assert.equal(Math.round(feed.active_power_w), -2400, "negative when the house feeds the grid");
  assert.ok(feed.power_factor < 0);
  meter.setPower(1000);
  const before = meter.importKwh;
  meter.advance(2);
  assert.ok(Math.abs(meter.importKwh - before - 2) < 1e-9, "1000 W for two hours is 2 kWh");
  meter.setPower(-3000);
  meter.advance(1);
  assert.ok(Math.abs(meter.exportKwh - 56.7 - 3) < 1e-9);
  const channel = sdmChannel(decodeSdm(meter.registers()));
  assert.deepEqual({ id: channel.id, domain: channel.domain, power_w: channel.power_w, energy_kwh: channel.energy_kwh }, { id: "grid", domain: "ac", power_w: -3000, energy_kwh: 1236.5 });
});

test("the decoder refuses a block that is too short or holds something that is not a number", () => {
  const meter = new SimulatedSdm();
  assert.throws(() => decodeSdm(meter.registers().slice(0, 0x20)), /does not reach/);
  assert.throws(() => decodeSdm(meter.registers(), 5), /does not reach|is not a number/);
  const block = meter.registers();
  block[SDM_REGISTERS.active_power_w] = 0x7fc0;       // a NaN
  block[SDM_REGISTERS.active_power_w + 1] = 0;
  assert.throws(() => decodeSdm(block), /not a number/);
});

test("the routes answer 404 while the option is off; once on, anybody who may operate reads and an administrator sets", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const json = { "content-type": "application/json", cookie: admin };
    const off = await fetch(`${running.base}/api/v1/electrical/balance`, { headers: json });
    assert.equal(off.status, 404);
    assert.equal(((await off.json()) as { code: string }).code, "balance_off");
    assert.equal((await fetch(`${running.base}/api/v1/electrical/balance`, { method: "PUT", headers: json, body: "{}" })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: json, body: JSON.stringify({ "electrical.balance": true }) })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/electrical/balance`)).status, 401);
    const state = await (await fetch(`${running.base}/api/v1/electrical/balance`, { headers: json })).json() as { enabled: boolean; balance: { import_w: number | null }; findings: unknown[] };
    assert.deepEqual({ enabled: state.enabled, grid: state.balance.import_w, findings: state.findings }, { enabled: true, grid: null, findings: [] });
    const saved = await fetch(`${running.base}/api/v1/electrical/balance`, { method: "PUT", headers: json, body: JSON.stringify({ allow_export: false, watch_channels: ["electrical-1/fridge"] }) });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { settings: { allow_export: boolean } }).settings.allow_export, false);
    assert.equal((await fetch(`${running.base}/api/v1/electrical/balance`, { method: "PUT", headers: json, body: JSON.stringify({ hold_s: 1 }) })).status, 422);
  } finally { await running.stop(); }
});
