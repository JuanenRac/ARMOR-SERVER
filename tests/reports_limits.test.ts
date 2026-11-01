// The limits of the two report routes (how long one may run, how many may wait, how many requests a minute) are settings, not constants: they start from the environment, an
// administrator changes them in Studio, a change counts at once, a value out of range is refused, and what they were before (20 s, 3 waiting, 30 a minute) is the default.
// Written as a characterization of the old constants first, then the settings, then the properties.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import type { FetchVision, ReportRun, RunReport } from "../src/reports.js";
import { Serial } from "../src/reports.js";
import { lowers, REPORT_QUEUE_MAX, REPORT_REQUESTS_PER_MINUTE, REPORT_TIMEOUT_S, SecuritySettings, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie, testConfig, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const REPORT = { summary: { schema: "armor-daily-summary/1", totals: { events: 0, alarms: 0, serious_alarms: 0, false_alarms: 0 }, by_type: {}, by_zone: {}, by_hour: new Array(24).fill(0) }, findings: [], text: "Daily summary" };
const MAP = { schema: "armor.vision.heatmap/v1", camera_id: "cam-front", cols: 2, rows: 1, accepted_positions: 1, rejected_positions: 0, total: 1, max: 1, weights: [[1, 0]], normalized: [[1, 0]], contains_images: false };
const ROUTES = { summary: "/api/v1/summary/daily", heatmap: "/api/v1/vision/heatmap" } as const;

function projects(): Record<string, string> {
  const root = tempDir();
  const ai = path.join(root, "ARMOR-SERVER-AI");
  fs.mkdirSync(path.join(ai, "src", "armor_server_ai"), { recursive: true });
  fs.writeFileSync(path.join(ai, "src", "armor_server_ai", "cli.py"), "");
  const summaryConfig = path.join(root, "summary.json");
  fs.writeFileSync(summaryConfig, "{}");
  return { ARMOR_DAILY_SUMMARY_AI_DIR: ai, ARMOR_DAILY_SUMMARY_CONFIG: summaryConfig, ARMOR_VISION_SERVICE_URL: "http://127.0.0.1:8765" };
}

/** A stand-in for the Python commands that remembers what it was asked and answers after `delayMs`. */
function runner(delayMs = 0): { run: RunReport; fetch: FetchVision; calls: ReportRun[]; timeouts: number[] } {
  const calls: ReportRun[] = [], timeouts: number[] = [];
  return {
    calls, timeouts,
    run: async run => {
      calls.push(run);
      if (delayMs > 0) await pause(delayMs);
      return { code: 0, stdout: Buffer.from(JSON.stringify(REPORT)), stderr: "" };
    },
    fetch: async (_url, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (delayMs > 0) await pause(delayMs);
      return { status: 200, type: "application/json", body: Buffer.from(JSON.stringify(MAP)) };
    },
  };
}
const put = (running: Running, cookie: string, body: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie }, body: JSON.stringify(body) });
const get = (running: Running, cookie: string, route: string) => fetch(`${running.base}${route}`, { headers: { cookie } });
async function started(env: Record<string, string>, stand: { run: RunReport; fetch: FetchVision }): Promise<{ running: Running; cookie: string }> {
  const running = await startServer({ ...projects(), ...env }, { runReport: stand.run, fetchVision: stand.fetch });
  const cookie = await studioCookie(running.base);
  assert.equal((await put(running, cookie, { "summary.daily": true, "vision.heatmap": true })).status, 200);
  return { running, cookie };
}

test("characterization: the limits are what the constants were (20 seconds, 3 waiting, 30 a minute) and a report is run with that timeout", async () => {
  assert.deepEqual([SECURITY_DEFAULTS["reports.timeout_s"], SECURITY_DEFAULTS["reports.queue_max"], SECURITY_DEFAULTS["reports.requests_per_minute"]], [20, 3, 30]);
  const stand = runner();
  const { running, cookie } = await started({}, stand);
  try {
    for (const route of Object.values(ROUTES)) assert.equal((await get(running, cookie, route)).status, 200, route);
    assert.deepEqual([...stand.calls.map(call => call.timeoutMs), ...stand.timeouts], [20_000, 20_000]);
    const one = new Serial();
    const four = await Promise.all([1, 2, 3, 4].map(n => one.run(async () => { await pause(10); return n; })));
    assert.deepEqual(four, [1, 2, 3, "busy"]);
  } finally { await running.stop(); }
});

test("the three limits start from the environment, can be changed in the settings with no restart, and a change counts for the next request", async () => {
  const stand = runner();
  const { running, cookie } = await started({ ARMOR_REPORT_TIMEOUT_S: "9" }, stand);
  try {
    const settings = running.app.context.securitySettings;
    assert.deepEqual([settings.get("reports.timeout_s"), settings.get("reports.queue_max"), settings.get("reports.requests_per_minute")], [9, 3, 30], "the environment is where the timeout starts");
    await get(running, cookie, ROUTES.summary);
    assert.equal(stand.calls.at(-1)!.timeoutMs, 9_000);
    assert.equal((await put(running, cookie, { "reports.timeout_s": 45 })).status, 200);
    await get(running, cookie, ROUTES.heatmap);
    assert.equal(stand.timeouts.at(-1), 45_000, "the heat map uses it too");
    await get(running, cookie, ROUTES.summary);
    assert.equal(stand.calls.at(-1)!.timeoutMs, 45_000);
    const stored = JSON.parse(fs.readFileSync(path.join(running.config.dataDir, "security-settings.json"), "utf8")).settings;
    assert.equal(stored["reports.timeout_s"], 45);
    assert.equal("reports.queue_max" in stored, false, "a limit nobody set stays out of the file, so the environment still decides it");
    const shown = (await (await get(running, cookie, "/api/v1/security/settings")).json()) as { settings: Record<string, unknown>; defaults: Record<string, unknown> };
    assert.equal(shown.settings["reports.timeout_s"], 45);
    assert.deepEqual([shown.defaults["reports.timeout_s"], shown.defaults["reports.queue_max"], shown.defaults["reports.requests_per_minute"]], [20, 3, 30]);
  } finally { await running.stop(); }
});

test("a limit out of its range, or not a whole number, is refused and changes nothing; the environment is held to the same range", async () => {
  const stand = runner();
  const { running, cookie } = await started({}, stand);
  try {
    for (const [key, bad] of [["reports.timeout_s", [4, 121, 7.5, "20", null, true]], ["reports.queue_max", [0, 11, 2.5, "3"]], ["reports.requests_per_minute", [0, 301, 30.5, "30"]]] as const) {
      for (const value of bad) assert.equal((await put(running, cookie, { [key]: value })).status, 400, `${key} ${String(value)}`);
    }
    const settings = running.app.context.securitySettings;
    assert.deepEqual([settings.get("reports.timeout_s"), settings.get("reports.queue_max"), settings.get("reports.requests_per_minute")], [20, 3, 30]);
    for (const [key, value] of [["reports.timeout_s", 5], ["reports.timeout_s", 120], ["reports.queue_max", 1], ["reports.queue_max", 10], ["reports.requests_per_minute", 1], ["reports.requests_per_minute", 300]] as const) {
      assert.equal((await put(running, cookie, { [key]: value })).status, 200, `${key} ${value}`);
    }
  } finally { await running.stop(); }
  for (const [name, value] of [["ARMOR_REPORT_TIMEOUT_S", "4"], ["ARMOR_REPORT_TIMEOUT_S", "121"], ["ARMOR_REPORT_QUEUE_MAX", "0"], ["ARMOR_REPORT_QUEUE_MAX", "11"], ["ARMOR_REPORT_REQUESTS_PER_MINUTE", "0"], ["ARMOR_REPORT_REQUESTS_PER_MINUTE", "301"], ["ARMOR_REPORT_TIMEOUT_S", "x"]]) {
    assert.throws(() => testConfig({ [name]: value }), ConfigError, `${name}=${value}`);
  }
});

test("the queue limit decides how many reports may wait before the answer is 503 report_busy, and a change counts at once", async () => {
  const stand = runner(300);
  const { running, cookie } = await started({}, stand);
  try {
    const statuses = async (count: number): Promise<number[]> => (await Promise.all(Array.from({ length: count }, () => get(running, cookie, ROUTES.summary)))).map(answer => answer.status).sort();
    assert.deepEqual(await statuses(4), [200, 200, 200, 503], "three, as it always was");
    assert.equal((await put(running, cookie, { "reports.queue_max": 1 })).status, 200);
    assert.deepEqual(await statuses(3), [200, 503, 503]);
    assert.equal((await put(running, cookie, { "reports.queue_max": 5 })).status, 200);
    assert.deepEqual(await statuses(6), [200, 200, 200, 200, 200, 503]);
  } finally { await running.stop(); }
});

test("the requests a minute are limited by the setting, for the two routes together, and a change counts at once", async () => {
  const stand = runner();
  const { running, cookie } = await started({ ARMOR_REPORT_REQUESTS_PER_MINUTE: "3" }, stand);
  try {
    assert.equal(running.app.context.securitySettings.get("reports.requests_per_minute"), 3);
    const codes: number[] = [];
    for (const route of [ROUTES.summary, ROUTES.heatmap, ROUTES.summary, ROUTES.heatmap]) codes.push((await get(running, cookie, route)).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.equal((await put(running, cookie, { "reports.requests_per_minute": 10 })).status, 200);
    assert.equal((await get(running, cookie, ROUTES.summary)).status, 200, "a higher limit lets the next one through");
  } finally { await running.stop(); }
});

test("the limits are tuning, not protection: changing them is not written as a loss of security, and they are in the file only when set", () => {
  for (const key of ["reports.timeout_s", "reports.queue_max", "reports.requests_per_minute"] as const) {
    assert.equal(lowers(key, 1, 100), false, key);
    assert.equal(lowers(key, 100, 1), false, key);
  }
  const file = path.join(tempDir(), "security-settings.json");
  const settings = new SecuritySettings(file, { initial: { "reports.timeout_s": 60, "reports.queue_max": 99 } });
  assert.equal(settings.get("reports.timeout_s"), 60, "the environment's value, when valid");
  assert.equal(settings.get("reports.queue_max"), 3, "one out of range keeps the default");
  settings.update({ "reports.requests_per_minute": 12 });
  const stored = JSON.parse(fs.readFileSync(file, "utf8")).settings;
  assert.equal(stored["reports.requests_per_minute"], 12);
  assert.equal("reports.timeout_s" in stored, false);
});

test("property: any whole number inside the range is accepted and any outside it is refused, for each limit", () => {
  let seed = 5;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  const ranges = { "reports.timeout_s": REPORT_TIMEOUT_S, "reports.queue_max": REPORT_QUEUE_MAX, "reports.requests_per_minute": REPORT_REQUESTS_PER_MINUTE } as const;
  for (const [key, range] of Object.entries(ranges)) {
    const settings = new SecuritySettings(path.join(tempDir(), "s.json"));
    assert.equal(range.default >= range.min && range.default <= range.max, true, "the default is inside the range");
    for (let round = 0; round < 100; round += 1) {
      const inside = range.min + random(range.max - range.min + 1);
      settings.update({ [key]: inside });
      assert.equal(settings.get(key as keyof typeof SECURITY_DEFAULTS), inside);
      const outside = random(2) === 0 ? range.min - 1 - random(50) : range.max + 1 + random(500);
      assert.throws(() => settings.update({ [key]: outside }), /invalid value/, `${key} ${outside}`);
      assert.equal(settings.get(key as keyof typeof SECURITY_DEFAULTS), inside, "a refused value changes nothing");
    }
  }
});
