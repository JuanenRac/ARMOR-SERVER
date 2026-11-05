// The sources of the summary of a day beyond the alarms: the lost links and the false alarms worked out from the alarms the server keeps, and the readings of the sensors and the power of
// the house from the daily log. Written as a characterization of what the summary was first (alarms only, nothing recorded, the settings at their old values), then the log, the
// events, the route and the properties. The AI only ever receives plain identifiers and numbers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Alarm } from "../src/alarms.js";
import { housePower } from "../src/context.js";
import { DailyLog, DEFAULT_SENSOR_FIELDS, type DailyLogOptions } from "../src/daily_log.js";
import { dayOf, secondOfDay } from "../src/day.js";
import { dailyEvents, type ReportRun, type RunReport } from "../src/reports.js";
import { lowers, SECURITY_DEFAULTS, SUMMARY_FALSE_ALARM_S, SUMMARY_LOG_DAYS, SUMMARY_POWER_EVERY_S, SUMMARY_READING_EVERY_S } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir, testConfig } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const MS = Date.parse("2026-03-05T10:00:00Z");
const alarm = (id: string, raisedAt: string, extra: Partial<Alarm> = {}): Alarm => ({ id, key: id, source: { type: "node", id: "radar-1" }, severity: "high", code: "intrusion", raised_at: raisedAt, ...extra });

function log(extra: Partial<DailyLogOptions> & { on?: { value: boolean } } = {}): { log: DailyLog; file: string; on: { value: boolean }; clock: { now: number } } {
  const file = path.join(tempDir(), "daily-log.json");
  const on = extra.on ?? { value: true };
  const clock = { now: MS };
  return { file, on, clock, log: new DailyLog({ file, enabled: () => on.value, days: () => 14, readingEveryS: () => 300, powerEveryS: () => 60, maxEventsPerDay: 5000, maxBytes: 4 * 1024 * 1024, sensorFields: DEFAULT_SENSOR_FIELDS, saveEveryMs: 10, now: () => clock.now, ...extra }) };
}

test("characterization: with the alarms alone the events are what they always were, and the settings keep their first values", () => {
  const day = dayOf(MS);
  const events = dailyEvents([alarm("a", new Date(MS).toISOString(), { detail: { zone: "garden", password: "hunter2" } }), alarm("b", "2026-03-04T10:00:00.000Z"), alarm("c", new Date(MS).toISOString(), { silent: true })], day);
  assert.deepEqual(events, [{ t_s: secondOfDay(MS), type: "alarm", code: "intrusion", severity: "high", zone: "garden", node: "radar-1" }]);
  assert.deepEqual([SECURITY_DEFAULTS["summary.log_days"], SECURITY_DEFAULTS["summary.reading_every_s"], SECURITY_DEFAULTS["summary.power_every_s"], SECURITY_DEFAULTS["summary.false_alarm_s"]], [14, 300, 60, 60]);
  assert.equal(SECURITY_DEFAULTS["summary.daily"], false);
});

test("a lost link is a node_link_lost with how long it lasted, a false alarm is an intrusion that a disarm ended at once, and nothing else of the alarm travels", () => {
  const day = dayOf(MS);
  const at = (s: number) => new Date(MS + s * 1000).toISOString();
  const events = dailyEvents([
    alarm("1", at(0), { code: "node_down", severity: "warning", cleared_at: at(120) }),
    alarm("2", at(10), { code: "camera_down", severity: "warning", source: { type: "camera", id: "gate" } }),
    alarm("3", at(20), { code: "solar_offline", severity: "warning", source: { type: "solar", id: "gw/inverter-1" }, cleared_at: at(50) }),
    alarm("4", at(30), { code: "door_open", severity: "high", source: { type: "device", id: "door-1" }, acknowledged_by: "disarm", cleared_at: at(40), detail: { zone: "hall", note: "x" } }),
    alarm("5", at(60), { code: "door_open", severity: "high", source: { type: "device", id: "door-2" }, acknowledged_by: "disarm", cleared_at: at(600) }),
    alarm("6", at(70), { code: "door_open", severity: "high", source: { type: "device", id: "door-3" }, acknowledged_by: "ana", cleared_at: at(75) }),
    alarm("7", at(80), { code: "node_down", severity: "warning", source: { type: "node", id: "../etc" }, cleared_at: at(90) }),
  ], day, { falseAlarmS: 60 });
  const by = (type: string) => events.filter(event => event.type === type);
  assert.deepEqual(by("node_link_lost").map(event => [event.node, event.duration_s]), [["radar-1", 120], ["gate", 86_400 - secondOfDay(MS + 10_000)], ["gw_inverter-1", 30]], "a name that is not a plain identifier after cleaning is not made one");
  assert.deepEqual(by("alarm").filter(event => event.code === "door_open").map(event => [event.code, event.false_alarm ?? false]), [["door_open", true], ["door_open", false], ["door_open", false]], "only the one a disarm ended within the window");
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /note|password|\.\.\/|gw\//);
  assert.deepEqual(Object.keys(events[0]!).sort(), ["duration_s", "node", "t_s", "type"]);
  // no window, nothing inferred
  assert.equal(dailyEvents([alarm("5", at(60), { code: "door_open", acknowledged_by: "disarm", cleared_at: at(61) })], day, { falseAlarmS: 0 }).some(event => event.false_alarm), false);
  assert.equal(dailyEvents([alarm("5", at(60), { code: "door_open", acknowledged_by: "disarm", cleared_at: at(61) })], day).some(event => event.false_alarm), false);
});

test("the daily log records nothing while the summary is off, and only readings of the listed fields with plain names and finite numbers", () => {
  const { log: l, on, clock } = log({ on: { value: false } });
  l.reading("sensor-1", "temperature", 21.5);
  l.power(900);
  assert.deepEqual(l.size(), { days: 0, events: 0 });
  on.value = true;
  l.reading("sensor-1", "temperature", 21.5);
  l.reading("sensor-1", "token", 5);                 // not a reading field
  l.reading("sensor 1", "temperature", 5);           // not a plain name
  l.reading("sensor-1", "humidity", Number.NaN);
  l.reading("sensor-1", "humidity", "40");
  l.reading("sensor-1", "humidity", 1e13);
  l.power(-5); l.power(Number.POSITIVE_INFINITY); l.power("1");
  assert.deepEqual(l.events(dayOf(clock.now)).map(event => event.type), ["reading"]);
  l.power(1234.56);
  const held = l.events(dayOf(clock.now));
  assert.deepEqual(held.map(event => event.type), ["reading", "power"]);
  assert.equal(held[1]!.watts, 1234.6);
});

test("a sensor is logged at most once per interval, the house power by its own interval, and a clock that goes back does not lock it out", () => {
  const { log: l, clock } = log();
  const day = () => dayOf(clock.now);
  l.reading("s", "temperature", 20); clock.now += 299_000; l.reading("s", "temperature", 21);
  assert.equal(l.events(day()).length, 1);
  clock.now += 1000; l.reading("s", "temperature", 22); l.reading("other", "temperature", 5);
  assert.equal(l.events(day()).length, 3);
  l.power(100); clock.now += 59_000; l.power(110); clock.now += 1000; l.power(120);
  assert.deepEqual(l.events(day()).filter(event => event.type === "power").map(event => event.watts), [100, 120]);
  clock.now -= 3_600_000; l.power(130);
  assert.equal(l.events(day()).filter(event => event.type === "power").length, 3, "time went back: it is not locked out");
});

test("the bounds hold: the days kept, the events of a day and the bytes of the file, oldest first", () => {
  const days = { value: 3 };
  const { log: l, clock } = log({ days: () => days.value, maxEventsPerDay: 5, readingEveryS: () => 10 });
  for (let d = 0; d < 6; d += 1) { clock.now = MS + d * 86_400_000; l.reading("s", "temperature", d); }
  assert.equal(l.size().days, 3);
  assert.deepEqual(l.events(dayOf(MS)), [], "the oldest day went first");
  clock.now = MS + 5 * 86_400_000;
  for (let i = 1; i < 20; i += 1) { clock.now += 11_000; l.reading("s", "temperature", i); }
  assert.equal(l.events(dayOf(clock.now)).length, 5, "a day that is full stops taking samples");
  assert.ok(l.dropped > 0);
  days.value = 1;
  clock.now += 11_000; l.reading("s", "battery", 50);
  assert.equal(l.size().days, 1, "the days are read again from the setting");
  const small = log({ maxBytes: 2000, readingEveryS: () => 10 });
  for (let d = 0; d < 10; d += 1) { small.clock.now = MS + d * 86_400_000; for (let i = 0; i < 8; i += 1) { small.clock.now += 11_000; small.log.reading("s", "temperature", i); } }
  small.log.flush();
  assert.ok(fs.statSync(small.file).size <= 2000 + 1200, "the file stays near its bound (one day at least is always kept)");
  assert.ok(small.log.size().days < 10);
});

test("the log survives a restart, is written atomically with no temporary file left, and a damaged or hostile file is ignored", async () => {
  const { log: first, file, clock } = log();
  first.reading("s", "temperature", 20.25); first.power(500);
  first.flush();
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp")), []);
  const again = new DailyLog({ file, enabled: () => true, days: () => 14, readingEveryS: () => 300, powerEveryS: () => 60, maxEventsPerDay: 5000, maxBytes: 1 << 20, sensorFields: DEFAULT_SENSOR_FIELDS, now: () => clock.now });
  assert.deepEqual(again.events(dayOf(clock.now)).map(event => event.type), ["reading", "power"]);
  const hostile = path.join(tempDir(), "daily-log.json");
  fs.writeFileSync(hostile, JSON.stringify({ schema: 1, days: { "2026-03-05": [{ t_s: 5, type: "reading", node: "bad name", sensor: "temperature", value: 1 }, { t_s: -1, type: "power", watts: 5 }, { t_s: 5, type: "power", watts: "x" }, { t_s: 9, type: "other" }, { t_s: 10, type: "power", watts: 50 }], "not a day": [{ t_s: 1, type: "power", watts: 1 }] } }));
  const clean = new DailyLog({ file: hostile, enabled: () => true, days: () => 14, readingEveryS: () => 300, powerEveryS: () => 60, maxEventsPerDay: 5000, maxBytes: 1 << 20, sensorFields: DEFAULT_SENSOR_FIELDS });
  assert.deepEqual(clean.events("2026-03-05"), [{ t_s: 10, type: "power", watts: 50 }]);
  assert.equal(clean.size().days, 1);
  const broken = path.join(tempDir(), "daily-log.json");
  fs.writeFileSync(broken, "{not json");
  assert.equal(new DailyLog({ file: broken, enabled: () => true, days: () => 14, readingEveryS: () => 300, powerEveryS: () => 60, maxEventsPerDay: 10, maxBytes: 1 << 20, sensorFields: DEFAULT_SENSOR_FIELDS }).size().events, 0);
  // a file that cannot be written never reaches the one who records
  const warned: string[] = [];
  const blocked = new DailyLog({ file: path.join(first.size().days ? file : file, "inside", "x.json"), enabled: () => true, days: () => 14, readingEveryS: () => 300, powerEveryS: () => 60, maxEventsPerDay: 10, maxBytes: 1 << 20, sensorFields: DEFAULT_SENSOR_FIELDS, warn: message => warned.push(message) });
  blocked.power(10);
  blocked.flush();
  assert.equal(warned.length, 1);
});

test("the power of the house is the main meter, or else the largest AC channel", () => {
  assert.equal(housePower([{ id: "kitchen", domain: "ac", power_w: 300 }, { id: "grid", domain: "ac", power_w: 2810.5 }]), 2810.5);
  assert.equal(housePower([{ id: "a", domain: "ac", power_w: 300 }, { id: "b", domain: "ac", power_w: 900 }, { id: "pv", domain: "dc", power_w: 5000 }]), 900);
  assert.equal(housePower([{ id: "main", domain: "ac", power_w: -50 }]), 0);
  assert.equal(housePower([{ id: "pv", domain: "dc", power_w: 5000 }]), undefined);
  assert.equal(housePower([]), undefined);
});

test("the new settings: ranges, environment start, and tuning is not a loss of security", async () => {
  for (const [key, range] of [["summary.log_days", SUMMARY_LOG_DAYS], ["summary.reading_every_s", SUMMARY_READING_EVERY_S], ["summary.power_every_s", SUMMARY_POWER_EVERY_S], ["summary.false_alarm_s", SUMMARY_FALSE_ALARM_S]] as const) {
    assert.equal(lowers(key, range.min, range.max), false, key);
    assert.equal(SECURITY_DEFAULTS[key], range.default, key);
  }
  for (const [name, value] of [["ARMOR_DAILY_LOG_DAYS", "0"], ["ARMOR_DAILY_LOG_DAYS", "91"], ["ARMOR_DAILY_LOG_READING_EVERY_S", "9"], ["ARMOR_DAILY_LOG_POWER_EVERY_S", "4"], ["ARMOR_DAILY_FALSE_ALARM_S", "601"], ["ARMOR_DAILY_LOG_MAX_EVENTS", "99"], ["ARMOR_DAILY_LOG_MAX_BYTES", "100"], ["ARMOR_DAILY_LOG_SENSORS", "Temp"], ["ARMOR_DAILY_LOG_SENSORS", ",,"], ["ARMOR_DAILY_LOG_SENSORS", "a b"]]) {
    assert.throws(() => testConfig({ [name]: value }), /must be/, `${name}=${value}`);
  }
  const config = testConfig({ ARMOR_DAILY_LOG_SENSORS: "temperature, flow_rate", ARMOR_DAILY_LOG_DAYS: "30" });
  assert.deepEqual(config.dailyLogSensors, ["temperature", "flow_rate"]);
  assert.equal(config.dailyLogDays, 30);
  const running = await startServer({ ARMOR_DAILY_LOG_DAYS: "30", ARMOR_DAILY_FALSE_ALARM_S: "0" });
  try {
    const admin = await studioCookie(running.base);
    const set = (body: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(body) });
    const settings = running.app.context.securitySettings;
    assert.deepEqual([settings.get("summary.log_days"), settings.get("summary.false_alarm_s")], [30, 0], "the environment is where they start");
    for (const bad of [{ "summary.log_days": 0 }, { "summary.log_days": 91 }, { "summary.reading_every_s": 9 }, { "summary.power_every_s": 3601 }, { "summary.false_alarm_s": 601 }, { "summary.false_alarm_s": 1.5 }, { "summary.log_days": "14" }]) assert.equal((await set(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await set({ "summary.log_days": 7, "summary.false_alarm_s": 120 })).status, 200);
    assert.deepEqual([settings.get("summary.log_days"), settings.get("summary.false_alarm_s")], [7, 120]);
  } finally { await running.stop(); }
});

test("route: the summary is handed the lost links, the false alarms, the readings and the power, only while the option is on, and nothing but plain facts", async () => {
  const dir = tempDir(), root = tempDir();
  const day = dayOf(Date.now());
  const ai = path.join(root, "ARMOR-SERVER-AI");
  fs.mkdirSync(path.join(ai, "src", "armor_server_ai"), { recursive: true });
  fs.writeFileSync(path.join(ai, "src", "armor_server_ai", "cli.py"), "");
  const summaryConfig = path.join(root, "summary.json");
  fs.writeFileSync(summaryConfig, "{}");
  const nowIso = (offsetS: number) => new Date(Date.parse(`${day}T00:00:00`) + offsetS * 1000).toISOString();
  void nowIso;
  let handed = "";
  const calls: ReportRun[] = [];
  const run: RunReport = async item => { calls.push(item); handed = fs.readFileSync(item.args[item.args.indexOf("--daily-summary") + 1]!, "utf8"); return { code: 0, stdout: Buffer.from(JSON.stringify({ summary: { schema: "armor-daily-summary/1", totals: { events: 0, alarms: 0, serious_alarms: 0, false_alarms: 0 }, by_type: {}, by_zone: {}, by_hour: new Array(24).fill(0) }, findings: [], text: "ok" })), stderr: "" }; };
  const running = await startServer({ ARMOR_DATA_DIR: dir, ARMOR_DAILY_SUMMARY_AI_DIR: ai, ARMOR_DAILY_SUMMARY_CONFIG: summaryConfig, ARMOR_DAILY_LOG_READING_EVERY_S: "10", ARMOR_DAILY_LOG_POWER_EVERY_S: "5" }, { runReport: run });
  try {
    const { context } = running.app;
    const admin = await studioCookie(running.base);
    context.devices.create({ id: "sensor-1", name: "Hall sensor", kind: "temperature", location: "Hall" });
    context.devices.applyState("sensor-1", { temperature: 21.5 });
    await context.electricalNodes.ingest({ kind: "electrical", node_id: "electrical-1", timestamp_ms: Date.now(), channels: [{ id: "grid", domain: "ac", power_w: 2810.5 }] } as never);
    assert.deepEqual(context.dailyLog.size(), { days: 0, events: 0 }, "nothing is recorded while the summary is off");
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "summary.daily": true }) })).status, 200);
    context.devices.applyState("sensor-1", { temperature: 22.5, token: 99 } as never);
    await context.electricalNodes.ingest({ kind: "electrical", node_id: "electrical-1", timestamp_ms: Date.now() + 1, channels: [{ id: "grid", domain: "ac", power_w: 2900 }, { id: "oven", domain: "ac", power_w: 1500 }] } as never);
    context.alarms.raise("node:radar-1:down", { source: { type: "node", id: "radar-1" }, severity: "warning", code: "node_down" });
    context.alarms.clear("node:radar-1:down");
    const answer = await fetch(`${running.base}/api/v1/summary/daily?date=${day}`, { headers: { cookie: admin } });
    assert.equal(answer.status, 200);
    const events = handed.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events.map(event => event.type).sort(), ["node_link_lost", "power", "reading"]);
    assert.deepEqual(events.find(event => event.type === "reading"), { t_s: events.find(event => event.type === "reading")!.t_s, type: "reading", node: "sensor-1", sensor: "temperature", value: 22.5 });
    assert.equal(events.find(event => event.type === "power")!.watts, 2900);
    assert.equal(events.find(event => event.type === "node_link_lost")!.node, "radar-1");
    assert.doesNotMatch(handed, /Hall sensor|token|"value":99|oven|electrical-1/, "names, free text and other fields never reach the summary");
    // the log is on disk with nothing else in it
    context.dailyLog.flush();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "daily-log.json"), "utf8")) as { days: Record<string, unknown[]> };
    assert.equal(Object.values(stored.days).flat().length, 2);
    assert.equal((fs.statSync(path.join(dir, "daily-log.json")).mode & 0o077) === 0 || process.platform === "win32", true);
  } finally { await running.stop(); }
});

test("property: whatever comes in, the log never holds more days, events or bytes than its bounds and every event it holds is valid", () => {
  let seed = 9;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  for (let round = 0; round < 40; round += 1) {
    const maxEvents = 100 + random(50), days = 1 + random(5), maxBytes = 3000 + random(5000);
    const { log: l, clock, file } = log({ days: () => days, maxEventsPerDay: maxEvents, maxBytes, readingEveryS: () => 10 + random(5), powerEveryS: () => 5 + random(5) });
    for (let step = 0; step < 400; step += 1) {
      clock.now += random(40_000) + (random(50) === 0 ? 86_400_000 : 0);
      const pick = random(4);
      if (pick === 0) l.power(random(5000) / 3);
      else if (pick === 1) l.reading(`s${random(4)}`, DEFAULT_SENSOR_FIELDS[random(DEFAULT_SENSOR_FIELDS.length)]!, random(1000) / 7);
      else if (pick === 2) l.reading(`bad name ${random(3)}`, "temperature", 1);
      else l.reading("s0", "secret", random(9));
    }
    const { days: held, events } = l.size();
    assert.ok(held <= days, `days ${held} <= ${days}`);
    assert.ok(events <= days * maxEvents);
    l.flush();
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { days: Record<string, Array<Record<string, unknown>>> };
      for (const list of Object.values(stored.days)) for (const event of list) {
        assert.ok(event.type === "reading" || event.type === "power");
        assert.ok(typeof event.t_s === "number" && event.t_s >= 0 && event.t_s < 86_400);
        if (event.type === "reading") assert.match(String(event.node), /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
      }
    }
  }
});
