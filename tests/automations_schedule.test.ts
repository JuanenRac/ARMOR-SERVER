import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AutomationEngine, AutomationError, MAX_JITTER_MIN, SCHEDULE_GRACE_MIN, scheduledMinute, seededUnit } from "../src/automations.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { tempDir } from "./helpers.js";

// The local clock of the test: 2026-03-03 is a Tuesday (getDay() === 2).
const at = (hour: number, minute: number, day = 3) => new Date(2026, 2, day, hour, minute, 0);

function build(options: { scheduling?: boolean; clock: () => Date }) {
  const ran: string[] = [];
  const engine = new AutomationEngine({
    file: path.join(tempDir(), "automations.json"), mode: () => "armed", now: options.clock, scheduling: options.scheduling === false ? () => false : () => true,
    run: async action => { if (action.type === "device") ran.push(`${action.device_id}=${action.command}`); },
  });
  return { engine, ran };
}
const light = (trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: "evening light", trigger, actions: [{ type: "device", device_id: "lamp-1", command: "on" }], ...extra }) as never;

test("the option is off by default, so no schedule ever runs unless an administrator turns the vacation mode on", () => {
  assert.equal(SECURITY_DEFAULTS["vacation.mode"], false);
  assert.equal(lowers("vacation.mode", false, true), false);
});

test("the jitter is repeatable from the seed and the day, differs between days and stays inside the range", () => {
  assert.equal(seededUnit("a|2026-03-03"), seededUnit("a|2026-03-03"));
  assert.notEqual(seededUnit("a|2026-03-03"), seededUnit("a|2026-03-04"));
  assert.notEqual(seededUnit("a|2026-03-03"), seededUnit("b|2026-03-03"));
  const minutes = new Set<number>();
  for (let day = 1; day <= 28; day += 1) {
    const minute = scheduledMinute({ at: "20:00", jitter_min: 30 }, "house", `2026-02-${String(day).padStart(2, "0")}`);
    assert.ok(minute >= 20 * 60 - 30 && minute <= 20 * 60 + 30, String(minute));
    minutes.add(minute);
  }
  assert.ok(minutes.size > 5, "it varies from one day to the next");
  assert.equal(scheduledMinute({ at: "20:00" }, "house", "2026-02-01"), 1200, "no jitter: exactly the time");
  assert.equal(scheduledMinute({ at: "00:10", jitter_min: 120 }, "x", "2026-02-01") >= 0, true, "never before midnight");
  assert.equal(scheduledMinute({ at: "23:55", jitter_min: 120 }, "x", "2026-02-01") <= 1439, true, "never after the end of the day");
});

test("a schedule runs once a day, when its moment has come, and only inside the grace after it", () => {
  let now = at(19, 59);
  const { engine, ran } = build({ clock: () => now });
  engine.create(light({ type: "schedule", at: "20:00" }));
  assert.equal(engine.tick(), 0, "not yet");
  now = at(20, 0);
  assert.equal(engine.tick(), 1);
  now = at(20, 5);
  assert.equal(engine.tick(), 0, "once a day");
  now = at(20, 0, 4);
  assert.equal(engine.tick(), 1, "and again the next day");
  now = at(20, SCHEDULE_GRACE_MIN + 5, 5);
  assert.equal(engine.tick(), 0, "a server that was down at that hour does not run it late");
  return new Promise<void>(resolve => setTimeout(() => { assert.deepEqual(ran, ["lamp-1=on", "lamp-1=on"]); resolve(); }, 30));
});

test("the days and the jitter decide the moment, and the same seed gives the same moment", () => {
  const trigger = { type: "schedule", at: "21:00", jitter_min: 45, seed: "home" };
  const due = scheduledMinute({ at: "21:00", jitter_min: 45 }, "home", "2026-03-03");
  let now = at(Math.floor(due / 60), due % 60);
  const first = build({ clock: () => now });
  first.engine.create(light(trigger));
  assert.equal(first.engine.tick(), 1);
  const second = build({ clock: () => now });
  second.engine.create(light({ ...trigger, days: [0, 1] }));   // Tuesday is not among them
  assert.equal(second.engine.tick(), 0);
  now = at(Math.floor((due - 1) / 60), (due - 1) % 60);
  const third = build({ clock: () => now });
  third.engine.create(light(trigger));
  assert.equal(third.engine.tick(), 0, "one minute before its moment");
});

test("nothing runs while the vacation mode is off or the system is not armed away, nor for a disabled automation or another mode", () => {
  const now = at(20, 10);
  const off = build({ scheduling: false, clock: () => now });
  off.engine.create(light({ type: "schedule", at: "20:00" }));
  assert.equal(off.engine.tick(), 0);
  const disabled = build({ clock: () => now });
  disabled.engine.create(light({ type: "schedule", at: "20:00" }, { enabled: false }));
  assert.equal(disabled.engine.tick(), 0);
  const disarmedOnly = build({ clock: () => now });
  disarmedOnly.engine.create(light({ type: "schedule", at: "20:00" }, { when_mode: "disarmed" }));
  assert.equal(disarmedOnly.engine.tick(), 0, "the automation asks for the system disarmed and it is armed");
  const noOption = new AutomationEngine({ file: path.join(tempDir(), "a.json"), mode: () => "armed", now: () => now, run: async () => undefined });
  noOption.create(light({ type: "schedule", at: "20:00" }));
  assert.equal(noOption.tick(), 0, "an engine with no way to say it may schedule never does");
});

test("the schedule trigger is validated: time of day, days, jitter and seed", () => {
  const { engine } = build({ clock: () => at(10, 0) });
  const bad = (trigger: Record<string, unknown>) => assert.throws(() => engine.create(light(trigger)), AutomationError, JSON.stringify(trigger));
  for (const trigger of [{ type: "schedule" }, { type: "schedule", at: "25:00" }, { type: "schedule", at: "9:00" }, { type: "schedule", at: "20:00", days: [] }, { type: "schedule", at: "20:00", days: [7] },
    { type: "schedule", at: "20:00", days: [1.5] }, { type: "schedule", at: "20:00", jitter_min: -1 }, { type: "schedule", at: "20:00", jitter_min: MAX_JITTER_MIN + 1 }, { type: "schedule", at: "20:00", jitter_min: 1.5 },
    { type: "schedule", at: "20:00", seed: "has space" }, { type: "schedule", at: "20:00", seed: "x".repeat(33) }]) bad(trigger);
  const ok = engine.create(light({ type: "schedule", at: "20:00", days: [3, 1, 3], jitter_min: 20, seed: "casa" }));
  assert.deepEqual(ok.trigger, { type: "schedule", at: "20:00", days: [1, 3], jitter_min: 20, seed: "casa" });
});
