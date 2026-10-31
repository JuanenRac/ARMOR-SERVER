// The arming modes (away, home, night): what the system did before them (characterization, with the modes OFF), then the matrix mode x sensor x event, the properties that must hold
// whatever the definitions are, and the access control (role, PIN, duress PIN, lockout, audit) of changing the mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ARMED_MODES, ArmingModes, ModeChangeError, ModesInvalid, parseArmingModes, type ArmingModesDocument, type Timers, type Unit } from "../src/arming_modes.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const auditText = (running: Running): string => fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
const setting = (running: Running, cookie: string, patch: Record<string, unknown>) => call(running, cookie, "PUT", "/api/v1/security/settings", patch);
const alarmCodes = async (running: Running, cookie: string): Promise<string[]> => {
  const body = (await call(running, cookie, "GET", "/api/v1/alarms")).body;
  return (body.active as Array<{ code: string; source: { id: string }; cleared_at?: string }>).filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.source.id}`).sort();
};
const telemetry = (running: Running, node: string, targets: number) => fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` },
  body: JSON.stringify({ node_id: node, timestamp_ms: Date.now(), lux: 100, targets: Array.from({ length: targets }, (_, index) => ({ sensor_id: 1, track_id: index + 1, x_mm: 1000, y_mm: 1000, speed_mm_s: 0 })) }) });

/** A house: two doors/windows and two motion sensors in four rooms, a radar node outside and a smoke detector. */
function house(running: Running): void {
  const { devices } = running.app.context;
  devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
  devices.create({ id: "kitchen-window", name: "Kitchen window", kind: "window", location: "Kitchen" });
  devices.create({ id: "living-motion", name: "Living motion", kind: "motion", location: "Living" });
  devices.create({ id: "bedroom-motion", name: "Bedroom motion", kind: "motion", location: "Bedroom" });
  devices.create({ id: "hall-smoke", name: "Hall smoke", kind: "smoke", location: "Hall" });
}
const DEFINITIONS = {
  modes: {
    away: {},
    home: { defends: ["zone:Hall", "zone:Kitchen", "node:garden"] },
    night: { defends: ["zone:Hall", "zone:Kitchen", "zone:Living", "node:garden"] },
  },
  schedule: [],
};
async function prepared(extra: Record<string, string> = {}): Promise<{ running: Running; cookie: string }> {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0", ...extra });
  const cookie = await studioCookie(running.base);
  house(running);
  return { running, cookie };
}
async function withPin(running: Running, cookie: string): Promise<void> {
  const me = ((await call(running, cookie, "GET", "/api/v1/users")).body.users as Array<{ id: string; current: boolean }>).find(user => user.current)!.id;
  assert.equal((await call(running, cookie, "PUT", `/api/v1/users/${me}/pin`, { pin: "2468", duress_pin: "1357" })).status, 200);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 1. What the system did before the modes (the modes are OFF by default, and that is how it must stay)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("characterization: with the modes off the system only arms and disarms, a client sees no new field, and every sensor is defended while armed", async () => {
  const { running, cookie } = await prepared();
  try {
    assert.equal(SECURITY_DEFAULTS["alarm.arming_modes"], false);
    assert.equal(SECURITY_DEFAULTS["alarm.mode_downgrade_pin"], "required");
    assert.equal(SECURITY_DEFAULTS["alarm.mode_schedule"], false);
    assert.equal(SECURITY_DEFAULTS["alarm.mode_schedule_lowers"], false);
    const status = (await call(running, cookie, "GET", "/api/v1/status")).body;
    assert.equal(status.mode, "disarmed");
    assert.equal("arming_mode" in status, false, "a state that says nothing of modes");
    const ingest = (id: string, state: unknown) => fetch(`${running.base}/api/v1/devices/state`, { method: "POST", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify({ device_id: id, state }) });
    await ingest("bedroom-motion", { triggered: true });
    assert.deepEqual(await alarmCodes(running, cookie), [], "disarmed: an intrusion sensor is only a state");
    await ingest("bedroom-motion", { triggered: false });
    const armed = await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal(armed.status, 200);
    assert.equal(armed.body.mode, "armed");
    assert.equal("arming_mode" in armed.body, false);
    await ingest("bedroom-motion", { triggered: true });
    await ingest("front-door", { open: true });
    await telemetry(running, "garden", 1);
    assert.deepEqual(await alarmCodes(running, cookie), ["door_open:front-door", "intrusion:garden", "motion:bedroom-motion"], "armed: all three sound, wherever they are");
    await ingest("hall-smoke", { triggered: true });
    assert.ok((await alarmCodes(running, cookie)).includes("smoke:hall-smoke"));
    const disarmed = await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" });
    assert.equal(disarmed.body.mode, "disarmed");
    assert.deepEqual(await alarmCodes(running, cookie), ["smoke:hall-smoke"], "disarming ends the intrusion alarms; smoke stays");
    const audit = auditText(running);
    assert.match(audit, /"action":"control\.arm"/);
    assert.match(audit, /"action":"control\.disarm"/);
  } finally { await running.stop(); }
});

test("characterization: the disarm asks for the PIN, the duress PIN disarms in silence, and three wrong PINs lock", async () => {
  const { running, cookie } = await prepared();
  try {
    await withPin(running, cookie);
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.code, "wrong_pin");
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed", pin: "0000" })).body.code, "wrong_pin");
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed", pin: "0000" })).status, 429);
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.mode, "armed", "still armed: nothing got through");
  } finally { await running.stop(); }
  const second = await prepared();
  try {
    await withPin(second.running, second.cookie);
    await call(second.running, second.cookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal((await call(second.running, second.cookie, "POST", "/api/v1/mode", { mode: "disarmed", pin: "1357" })).status, 200, "the duress PIN disarms");
    assert.match(auditText(second.running), /"detail":"duress"/);
  } finally { await second.running.stop(); }
});

test("with the modes off, home and night are refused and the definitions can be prepared without changing anything", async () => {
  const { running, cookie } = await prepared();
  try {
    for (const mode of ["home", "night"]) {
      const refused = await call(running, cookie, "POST", "/api/v1/mode", { mode });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, "modes_disabled");
    }
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" })).body.mode, "armed", "away is the armed of always");
    const read = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    assert.equal(read.enabled, false);
    assert.deepEqual(read.available, ["disarmed", "away"]);
    assert.equal(read.current, "away");
    assert.equal(read.downgrade_pin_required, true);
    assert.deepEqual(read.unassigned, ["home", "night"], "home and night start without zones");
    assert.deepEqual(read.modes, { away: {}, home: {}, night: {} });
    const saved = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { ...DEFINITIONS, revision: read.revision });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.unassigned, []);
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.mode, "armed", "editing arms nothing and changes nothing");
  } finally { await running.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 2. The matrix: mode x sensor x event
// ---------------------------------------------------------------------------------------------------------------------------------------------------

type Sensor = { name: string; zoned: string; fire: (running: Running) => Promise<unknown> | unknown; code: string; id: string };
const SENSORS: Sensor[] = [
  { name: "door in the hall", zoned: "hall", id: "front-door", code: "door_open", fire: running => running.app.context.devices.applyState("front-door", { open: true }) },
  { name: "window in the kitchen", zoned: "kitchen", id: "kitchen-window", code: "window_open", fire: running => running.app.context.devices.applyState("kitchen-window", { open: true }) },
  { name: "motion in the living room", zoned: "living", id: "living-motion", code: "motion", fire: running => running.app.context.devices.applyState("living-motion", { triggered: true }) },
  { name: "motion in the bedroom", zoned: "bedroom", id: "bedroom-motion", code: "motion", fire: running => running.app.context.devices.applyState("bedroom-motion", { triggered: true }) },
  { name: "radar node in the garden", zoned: "garden", id: "garden", code: "intrusion", fire: running => telemetry(running, "garden", 1) },
];
// which sensor each mode defends (the DEFINITIONS above)
const EXPECTED: Record<ArmedMode, string[]> = {
  away: ["front-door", "kitchen-window", "living-motion", "bedroom-motion", "garden"],
  home: ["front-door", "kitchen-window", "garden"],
  night: ["front-door", "kitchen-window", "living-motion", "garden"],
};
type ArmedMode = (typeof ARMED_MODES)[number];

for (const mode of ARMED_MODES) {
  test(`matrix: in ${mode}, each sensor sounds exactly when the mode defends it, and smoke sounds in any mode`, async () => {
    for (const sensor of SENSORS) {
      const { running, cookie } = await prepared();
      try {
        assert.equal((await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS)).status, 200);
        assert.equal((await setting(running, cookie, { "alarm.arming_modes": true })).status, 200);
        const armed = await call(running, cookie, "POST", "/api/v1/mode", { mode });
        assert.equal(armed.status, 200, `${mode}: ${JSON.stringify(armed.body)}`);
        assert.equal(armed.body.arming_mode, mode);
        assert.equal(armed.body.mode, "armed", "an older client reads armed");
        await sensor.fire(running);
        const sounded = (await alarmCodes(running, cookie)).includes(`${sensor.code}:${sensor.id}`);
        assert.equal(sounded, EXPECTED[mode].includes(sensor.id), `${mode} / ${sensor.name}`);
        running.app.context.devices.applyState("hall-smoke", { triggered: true });
        assert.ok((await alarmCodes(running, cookie)).includes("smoke:hall-smoke"), `${mode}: smoke`);
      } finally { await running.stop(); }
    }
  });
}

test("matrix: disarmed defends no intrusion sensor, and switching modes moves the defence with it", async () => {
  const { running, cookie } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true, "alarm.mode_downgrade_pin": "not_required" });
    for (const sensor of SENSORS) await sensor.fire(running);
    assert.deepEqual(await alarmCodes(running, cookie), [], "disarmed: nothing sounds");
    // arming away finds everything that is wrong
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    assert.equal((await alarmCodes(running, cookie)).length, 5, "away: the five that were open or triggered");
    // going home: what the mode does not defend stops being an alarm (it goes to the record), the rest stays
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).body.arming_mode, "home");
    assert.deepEqual(await alarmCodes(running, cookie), ["door_open:front-door", "intrusion:garden", "window_open:kitchen-window"]);
    const recent = (await call(running, cookie, "GET", "/api/v1/alarms")).body.recent as Array<{ code: string; acknowledged_by?: string }>;
    assert.ok(recent.some(alarm => alarm.code === "motion" && alarm.acknowledged_by === "mode"), "the motion alarms were settled by the change of mode");
    // and back to away: what is wrong in the newly defended rooms sounds again
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    assert.equal((await alarmCodes(running, cookie)).length, 5);
  } finally { await running.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Safe behaviour: no zones assigned, the PIN of a change that defends less, an older client, the audit
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("a mode with no zones assigned is refused with its reason, and armed only when it is confirmed", async () => {
  const { running, cookie } = await prepared();
  try {
    await setting(running, cookie, { "alarm.arming_modes": true });
    for (const mode of ["home", "night"]) {
      const refused = await call(running, cookie, "POST", "/api/v1/mode", { mode });
      assert.equal(refused.status, 409, mode);
      assert.equal(refused.body.code, "no_zones_assigned");
    }
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.mode, "disarmed", "the refusal arms nothing");
    assert.match(auditText(running), /"action":"control\.mode","outcome":"denied".*no zones assigned/);
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", confirm_unassigned: "yes" })).status, 400, "the confirmation is a boolean");
    const confirmed = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", confirm_unassigned: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.arming_mode, "home");
    assert.match(auditText(running), /control\.arm.*home \(nothing assigned, confirmed\)/);
    // a zone that names no sensor defends nothing either
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" });
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Attic"] }, night: {} } });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).body.code, "no_zones_assigned");
  } finally { await running.stop(); }
});

test("going to a mode that defends less asks for the PIN of a disarm; going to one that defends the same or more does not; disarming always works", async () => {
  const { running, cookie } = await prepared();
  try {
    await withPin(running, cookie);
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true });
    const post = (mode: string, pin?: string) => call(running, cookie, "POST", "/api/v1/mode", { mode, ...(pin === undefined ? {} : { pin }) });
    assert.equal((await post("away")).status, 200, "arming from disarmed never asks");
    const refused = await post("night");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "wrong_pin", "away -> night defends less");
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.arming_mode, "away", "nothing changed");
    assert.equal((await post("night", "2468")).body.arming_mode, "night");
    assert.equal((await post("home")).body.code, "wrong_pin", "night -> home defends less (the living room)");
    assert.equal((await post("away")).status, 200, "night -> away defends more: no PIN");
    assert.equal((await post("home", "2468")).status, 200);
    assert.equal((await post("night")).status, 200, "home -> night defends more: no PIN");
    assert.match(auditText(running), /"action":"control\.mode","outcome":"denied","actor":"admin","detail":"wrong pin"/);
    assert.match(auditText(running), /"action":"control\.mode","outcome":"allowed".*away -> night \(defends less\)/);
    // the lockout of the PIN is the one of the disarm
    await post("away");
    await post("night", "0000");
    await post("night", "0000");
    assert.equal((await post("night", "0000")).status, 429);
    assert.equal((await post("night", "2468")).status, 429, "the right PIN waits as well");
    // and a disarm still needs its own PIN, but with the PIN it always works, from any mode
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.arming_mode, "away");
  } finally { await running.stop(); }
});

test("the duress PIN lets a change that defends less through and raises the silent alarm like a disarm", async () => {
  const { running, cookie } = await prepared();
  try {
    await withPin(running, cookie);
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true });
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    const duress = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", pin: "1357" });
    assert.equal(duress.status, 200);
    assert.equal(duress.body.arming_mode, "home");
    assert.match(auditText(running), /"action":"control\.mode".*away -> home \(duress\)/);
    const alarms = (await call(running, cookie, "GET", "/api/v1/alarms")).body;
    assert.ok([...alarms.active, ...alarms.recent].some((alarm: { code: string }) => alarm.code === "duress_disarm"));
  } finally { await running.stop(); }
});

test("the administrator can turn the PIN of a change that defends less off, and the audit trail says it lowers the security", async () => {
  const { running, cookie } = await prepared();
  try {
    await withPin(running, cookie);
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true });
    assert.equal(lowers("alarm.mode_downgrade_pin", "required", "not_required"), true);
    assert.equal(lowers("alarm.mode_downgrade_pin", "not_required", "required"), false);
    assert.equal(lowers("alarm.arming_modes", true, false), false);
    assert.equal(lowers("alarm.mode_schedule_lowers", false, true), true);
    await setting(running, cookie, { "alarm.mode_downgrade_pin": "not_required" });
    assert.match(auditText(running), /alarm\.mode_downgrade_pin","detail":"required -> not_required \(lowers the security\)/);
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).status, 200, "no PIN asked now");
    // disarming still asks for its PIN: that setting is another one
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.code, "wrong_pin");
  } finally { await running.stop(); }
});

test("a client that knows no modes keeps working: armed is away, also while the system is in another mode", async () => {
  const { running, cookie } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true, "alarm.mode_downgrade_pin": "not_required" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" })).body.arming_mode, "away");
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" })).body.arming_mode, "away", "armed from an old client is the strongest defence");
    // armed by another door (the control API, the voice assistant): the mode is away, never a stale home
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" });
    running.app.context.store.arm("armed");
    assert.equal(running.app.context.armingModes.current(), "away");
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.mode, "disarmed");
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "weekend" })).body.code, "invalid_mode");
  } finally { await running.stop(); }
});

test("who may change the mode is the one who may arm and disarm: a viewer cannot, an operator can", async () => {
  const { running, cookie } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", DEFINITIONS);
    await setting(running, cookie, { "alarm.arming_modes": true });
    for (const role of ["viewer", "operator"]) {
      assert.equal((await call(running, cookie, "POST", "/api/v1/users", { username: `u-${role}`, password: `${role}-password-12345`, role })).status, 201);
      const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-12345` }) });
      const other = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
      const answer = await call(running, other, "POST", "/api/v1/mode", { mode: "home" });
      assert.equal(answer.status, role === "viewer" ? 403 : 200, role);
      assert.equal((await call(running, other, "PUT", "/api/v1/alarm/modes", DEFINITIONS)).status, 403, `${role} cannot edit the definitions`);
      assert.equal((await call(running, other, "GET", "/api/v1/alarm/modes")).status, 200, `${role} reads what is in force`);
    }
  } finally { await running.stop(); }
});

test("the definitions: validated, replaced as a whole with a revision, audited", async () => {
  const { running, cookie } = await prepared();
  try {
    const read = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    const bad = async (modes: unknown, schedule?: unknown) => (await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes, ...(schedule === undefined ? {} : { schedule }) }));
    assert.equal((await bad({ away: { defends: ["zone:Hall"] }, home: {}, night: {} })).body.code, "invalid_modes", "away defends everything: it has no list");
    assert.equal((await bad({ away: {}, home: { defends: ["room:Hall"] }, night: {} })).status, 400);
    assert.equal((await bad({ away: {}, home: { entry_delay_s: 301 }, night: {} })).status, 400);
    assert.equal((await bad({ away: {}, home: {} })).status, 400, "night is missing");
    assert.equal((await bad({ away: {}, home: {}, night: {}, extra: {} })).status, 400);
    assert.equal((await bad({ away: {}, home: {}, night: {} }, [{ mode: "disarmed", days: [1], at: "22:00" }])).status, 400, "a timetable never disarms");
    assert.equal((await bad({ away: {}, home: {}, night: {} }, [{ mode: "home", days: [1, 1], at: "22:00" }])).status, 400);
    assert.equal((await bad({ away: {}, home: {}, night: {} }, [{ mode: "home", days: [1], at: "24:00" }])).status, 400);
    assert.equal((await bad({ away: {}, home: {}, night: {} }, [{ mode: "home", days: [1], at: "22:00" }, { mode: "night", days: [1, 2], at: "22:00" }])).status, 400, "two changes at the same minute");
    const saved = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { ...DEFINITIONS, revision: read.revision });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, read.revision + 1);
    const stale = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { ...DEFINITIONS, revision: read.revision });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "conflict");
    assert.match(auditText(running), /"action":"arming_modes\.save","outcome":"allowed"/);
    assert.match(auditText(running), /"action":"arming_modes\.save","outcome":"denied"/);
  } finally { await running.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 4. Delays (real timers, one second)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("an entry sensor waits for the entry delay of the mode, and the disarm in time stops it", async () => {
  const { running, cookie } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall", "zone:Kitchen"], entry: ["device:front-door"], entry_delay_s: 1 }, night: {} } });
    await setting(running, cookie, { "alarm.arming_modes": true });
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    running.app.context.devices.applyState("front-door", { open: true });
    running.app.context.devices.applyState("kitchen-window", { open: true });
    assert.deepEqual(await alarmCodes(running, cookie), ["window_open:kitchen-window"], "the window sounds at once; the door waits");
    await pause(1300);
    assert.deepEqual(await alarmCodes(running, cookie), ["door_open:front-door", "window_open:kitchen-window"], "the door sounded when the delay was over");
  } finally { await running.stop(); }
  const second = await prepared();
  try {
    await call(second.running, second.cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall"], entry: ["device:front-door"], entry_delay_s: 1 }, night: {} } });
    await setting(second.running, second.cookie, { "alarm.arming_modes": true });
    await call(second.running, second.cookie, "POST", "/api/v1/mode", { mode: "home" });
    second.running.app.context.devices.applyState("front-door", { open: true });
    assert.equal((await call(second.running, second.cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.mode, "disarmed");
    await pause(1300);
    assert.deepEqual(await alarmCodes(second.running, second.cookie), [], "disarmed in time: the door never sounded");
  } finally { await second.running.stop(); }
});

test("an exit delay leaves the newly defended things alone until it ends, then raises what is still wrong", async () => {
  const { running, cookie } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: { exit_delay_s: 1 }, home: {}, night: {} } });
    await setting(running, cookie, { "alarm.arming_modes": true });
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    running.app.context.devices.applyState("front-door", { open: true });   // the person leaving opens the door
    running.app.context.devices.applyState("bedroom-motion", { triggered: true });
    assert.deepEqual(await alarmCodes(running, cookie), [], "inside the exit delay");
    running.app.context.devices.applyState("bedroom-motion", { triggered: false });
    await pause(1300);
    assert.deepEqual(await alarmCodes(running, cookie), ["door_open:front-door"], "the door was left open: it sounds at the end; the motion that went away does not");
    running.app.context.devices.applyState("living-motion", { triggered: true });
    assert.ok((await alarmCodes(running, cookie)).includes("motion:living-motion"), "after the delay everything is defended");
  } finally { await running.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 5. The engine alone: properties, the timetable, persistence
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    set: (run, ms) => { const id = next++; pending.set(id, { at: now + ms, run }); return id; },
    clear: handle => { pending.delete(handle as number); },
    advance(ms) { now += ms; for (const [id, item] of [...pending]) if (item.at <= now) { pending.delete(id); item.run(); } },
  };
}
function engine(options: { dir?: string; doc?: ArmingModesDocument; units?: Unit[]; locations?: Record<string, string>; enabled?: boolean; may?: boolean; clock?: { now: number } } = {}) {
  const state = { armed: false, switches: 0, exits: 0, reports: [] as string[] };
  const timers = fakeTimers();
  const clock = options.clock ?? { now: Date.parse("2026-01-05T08:00:00Z") };   // a Monday
  const units = options.units ?? [{ type: "device", id: "door" }, { type: "device", id: "motion" }, { type: "node", id: "radar" }, { type: "camera", id: "cam" }];
  const modes = new ArmingModes({
    file: path.join(options.dir ?? tempDir(), "arming-modes.json"), now: () => clock.now, timers,
    enabled: () => options.enabled !== false, scheduleEnabled: () => true, scheduleMayLower: () => options.may === true,
    universe: () => units, locationOf: unit => options.locations?.[unit.id],
    isArmed: () => state.armed, setArmed: armed => { state.armed = armed; modes.storeChanged(armed); },
    afterSwitch: () => { state.switches += 1; }, afterExit: () => { state.exits += 1; },
    report: what => state.reports.push(`${what.applied ? "applied" : "skipped"} ${what.mode}${what.reason ? ` ${what.reason}` : ""}`),
  });
  if (options.doc) modes.replace(options.doc, undefined, "test");
  return { modes, state, timers, clock };
}

test("property: whatever the definitions are, a unit a mode marks is guarded by it, and one it does not mark is not (and away guards every unit)", () => {
  let seed = 7;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  const pool: Unit[] = [..."abcdef"].map(id => ({ type: "device", id: `d-${id}` } as Unit)).concat([{ type: "node", id: "n1" }, { type: "camera", id: "c1" }]);
  const zones: Record<string, string> = { "d-a": "Hall", "d-b": "Hall", "d-c": "Kitchen", "d-d": "Living", "d-e": "kitchen ", "d-f": "Attic" };
  for (let round = 0; round < 200; round += 1) {
    const marked = (): string[] => {
      const refs = new Set<string>();
      for (let count = random(5); count > 0; count -= 1) refs.add(random(3) === 0 ? `zone:${["Hall", "Kitchen", "Living", "Attic"][random(4)]}` : `${["device", "node", "camera"][random(3)]}:${["d-a", "d-b", "d-c", "n1", "c1", "ghost"][random(6)]}`);
      return [...refs];
    };
    const doc: ArmingModesDocument = { modes: { away: {}, home: { defends: marked() }, night: { defends: marked() } }, schedule: [] };
    const { modes, state } = engine({ doc, units: pool, locations: zones });
    for (const mode of ARMED_MODES) {
      state.armed = false; modes.storeChanged(false);
      modes.apply(mode, { confirmUnassigned: true });
      assert.equal(modes.current(), mode);
      for (const unit of pool) {
        const refs = mode === "away" ? undefined : doc.modes[mode].defends!;
        const expected = mode === "away" || refs!.some(ref => (ref.startsWith("zone:") ? (zones[unit.id] ?? "").trim().toLowerCase() === ref.slice(5).toLowerCase() : ref === `${unit.type}:${unit.id}`));
        assert.equal(modes.guards(unit.type, unit.id), expected, `${mode} ${unit.type}:${unit.id} with ${JSON.stringify(refs)}`);
      }
    }
  }
});

test("property: disarming always works, from any mode, with the modes on or off, and leaves nothing running", () => {
  let seed = 11;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  for (let round = 0; round < 200; round += 1) {
    const on = random(2) === 0;
    const { modes, state, timers } = engine({ enabled: on, doc: { modes: { away: { exit_delay_s: random(3) }, home: { defends: ["device:door"], exit_delay_s: random(3) }, night: { defends: ["device:motion"], entry: ["device:door"], entry_delay_s: 5 } }, schedule: [] } });
    for (let step = 0; step < 6; step += 1) {
      const target = (["away", "home", "night", "disarmed"] as const)[random(4)];
      try { modes.apply(target, { confirmUnassigned: random(2) === 0 }); } catch (error) { assert.ok(error instanceof ModeChangeError); }
      if (random(3) === 0) modes.later("k", 5000, () => undefined);
    }
    modes.apply("disarmed");
    assert.equal(state.armed, false);
    assert.equal(modes.current(), "disarmed");
    assert.equal(modes.exitUntil(), undefined);
    assert.equal(modes.guards("device", "door"), !on, "disarmed guards nothing; with the modes off the rules decide by the store's mode alone");
    const before = state.exits;
    timers.advance(60_000);
    assert.equal(state.exits, before, "an exit delay that was running does not end after the disarm");
  }
});

test("property: a change to a mode that defends less is flagged, one that defends the same or more is not, whatever the definitions", () => {
  let seed = 3;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  const names = ["device:door", "device:motion", "node:radar", "camera:cam"];
  for (let round = 0; round < 300; round += 1) {
    const pick = (): string[] => names.filter(() => random(2) === 0);
    const doc: ArmingModesDocument = { modes: { away: {}, home: { defends: pick() }, night: { defends: pick() } }, schedule: [] };
    const { modes, state } = engine({ doc });
    const units = [{ type: "device", id: "door" }, { type: "device", id: "motion" }, { type: "node", id: "radar" }, { type: "camera", id: "cam" }] as Unit[];
    for (const from of ARMED_MODES) for (const to of ARMED_MODES) {
      if (from === to) continue;
      state.armed = false; modes.storeChanged(false);
      modes.apply(from, { confirmUnassigned: true });
      const plan = modes.plan(to);
      const lost = units.some(unit => modes.defends(from, unit) && !modes.defends(to, unit));
      assert.equal(plan.lowers, lost, `${from} -> ${to}`);
      if (to === "away") assert.equal(plan.lowers, false, "away defends everything: never less");
    }
  }
});

test("the exit delay protects only what the mode newly defends, and a switch tells the rules once", () => {
  const { modes, state, timers, clock } = engine({ doc: { modes: { away: { exit_delay_s: 30 }, home: { defends: ["device:door"] }, night: {} }, schedule: [] } });
  modes.apply("home");
  assert.equal(modes.guards("device", "door"), true);
  modes.apply("away");
  assert.equal(state.switches, 1);
  assert.equal(modes.guards("device", "door"), true, "defended before and after: guarded all along");
  assert.equal(modes.guards("device", "motion"), false, "newly defended: not yet");
  assert.ok(modes.exitUntil());
  clock.now += 31_000; timers.advance(31_000);
  assert.equal(modes.guards("device", "motion"), true);
  assert.equal(state.exits, 1);
});

test("the timetable changes the mode once at its minute, never disarms, and does not defend less unless it is allowed", () => {
  const doc: ArmingModesDocument = { modes: { away: {}, home: { defends: ["device:door"] }, night: { defends: ["device:door", "device:motion"] } }, schedule: [
    { mode: "night", days: [1, 2, 3, 4, 5, 6, 7], at: "08:05" }, { mode: "home", days: [1], at: "08:10" }, { mode: "away", days: [2], at: "08:15" }, { mode: "home", days: [1], at: "08:20" }] };
  const at = (clock: { now: number }, text: string): Date => { clock.now = Date.parse(`2026-01-05T${text}:00Z`); return new Date(clock.now); };
  const first = engine({ doc });
  process.env.ARMOR_TZ = "UTC";
  first.modes.tick(at(first.clock, "08:04"));
  assert.equal(first.modes.current(), "disarmed", "not yet");
  first.modes.tick(at(first.clock, "08:05"));
  assert.equal(first.modes.current(), "night", "a Monday at 08:05: from disarmed it arms, which defends more");
  first.modes.tick(at(first.clock, "08:05"));
  assert.equal(first.state.reports.length, 1, "once per minute");
  first.modes.tick(at(first.clock, "08:10"));
  assert.equal(first.modes.current(), "night", "home would defend less than night: skipped unless it is allowed");
  assert.deepEqual(first.state.reports, ["applied night", "skipped home would_defend_less"]);
  const allowed = engine({ doc, may: true });
  allowed.modes.tick(at(allowed.clock, "08:05"));
  allowed.modes.tick(at(allowed.clock, "08:10"));
  assert.equal(allowed.modes.current(), "home", "allowed by the administrator");
  allowed.modes.tick(at(allowed.clock, "08:15"));
  assert.equal(allowed.modes.current(), "home", "a Tuesday entry does not fire on a Monday");
  const off = engine({ doc, enabled: false });
  off.modes.tick(at(off.clock, "08:05"));
  assert.equal(off.state.armed, false, "the modes are off: no timetable");
  const empty = engine({ doc: { modes: { away: {}, home: {}, night: {} }, schedule: [{ mode: "home", days: [1], at: "08:05" }] } });
  empty.modes.tick(at(empty.clock, "08:05"));
  assert.equal(empty.state.armed, false, "a timetable never arms a mode with no zones");
  assert.deepEqual(empty.state.reports, ["skipped home no_zones_assigned"]);
});

test("the definitions and the mode survive a restart, and a damaged file means no zones (never a guess)", () => {
  const dir = tempDir();
  const first = engine({ dir, locations: { door: "Hall" }, doc: { modes: { away: {}, home: { defends: ["zone:Hall"] }, night: {} }, schedule: [] } });
  first.modes.apply("home");
  const second = engine({ dir });
  assert.deepEqual(second.modes.get().modes.home, { defends: ["zone:Hall"] });
  second.state.armed = true;
  assert.equal(second.modes.current(), "home");
  fs.writeFileSync(path.join(dir, "arming-modes.json"), "{ not json");
  const damaged = engine({ dir });
  assert.deepEqual(damaged.modes.get().modes, { away: {}, home: {}, night: {} });
  const refused = (): void => { damaged.modes.apply("night"); };
  assert.throws(refused, (error: unknown) => error instanceof ModeChangeError && error.code === "no_zones_assigned");
});

test("parsing: the definitions follow the contract", () => {
  assert.doesNotThrow(() => parseArmingModes({ modes: { away: { exit_delay_s: 0, entry_delay_s: 300 }, home: { defends: ["zone:Kitchen", "device:front-door"], entry: ["device:front-door"] }, night: {} } }));
  for (const bad of [null, [], { modes: null }, { modes: { away: {}, home: {} } }, { modes: { away: {}, home: {}, night: { defends: "zone:Hall" } } }, { modes: { away: {}, home: {}, night: { defends: ["zone:"] } } },
    { modes: { away: {}, home: {}, night: { defends: ["zone:Hall", "zone:Hall"] } } }, { modes: { away: {}, home: {}, night: { defends: Array.from({ length: 65 }, (_, index) => `device:d${index}`) } } },
    { modes: { away: {}, home: {}, night: { exit_delay_s: 1.5 } } }, { modes: { away: {}, home: {}, night: { siren: false } } }, { modes: { away: {}, home: {}, night: {}, day: {} } }]) {
    assert.throws(() => parseArmingModes(bad), ModesInvalid, JSON.stringify(bad));
  }
});

test("the parser of the definitions agrees with every shared conformance vector", { skip: fs.existsSync(path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance", "arming_modes.json")) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const file = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance", "arming_modes.json");
  const vectors = (JSON.parse(fs.readFileSync(file, "utf8")) as { vectors: Array<{ name: string; valid: boolean; payload: unknown }> }).vectors;
  assert.ok(vectors.length > 30);
  for (const vector of vectors) {
    if (vector.valid) assert.doesNotThrow(() => parseArmingModes(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseArmingModes(vector.payload), `should reject: ${vector.name}`);
  }
});
