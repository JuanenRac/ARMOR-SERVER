// The profile each arming mode arms is checked when the definition is SAVED, against the profiles that exist; a panel the list names that does not exist (yet) is saved and is a failed
// panel with its alarm at the first arming, never a silent skip.
import assert from "node:assert/strict";
import test from "node:test";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};
const MODES = { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall"] } };

async function prepared() {
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1", ARMOR_ALERT_DWELL_MS: "0" });
  const cookie = await studioCookie(running.base);
  running.app.context.alarmNodes.ingest({ kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, arm_profiles: true, zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }], open_zones: [], events: [] });
  running.app.context.devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
  const settings = await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": true, "alarm.mode_panel_sync": true });
  assert.equal(settings.status, 200);
  return { running, cookie };
}

test("saving a mode that arms a profile that does not exist is refused with the reason, and nothing changes", async () => {
  const { running, cookie } = await prepared();
  try {
    const first = (await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: MODES })).body;
    const refused = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: MODES, revision: first.revision, panel_map: { profiles: { night: "gone" } } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_modes");
    assert.match(refused.body.error, /panel_map\.profiles\.night: the profile gone does not exist/);
    const after = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    assert.equal(after.revision, first.revision, "the definition was not replaced");
    assert.deepEqual(after.panel_map, {});
    const audit = (await call(running, cookie, "GET", "/api/v1/audit")).body;
    assert.ok(JSON.stringify(audit).includes("arming_modes.save"), "the refusal is audited");
  } finally { await running.stop(); }
});

test("a profile that exists is accepted, one by one, whichever mode names it", async () => {
  const { running, cookie } = await prepared();
  try {
    const profiles = (await call(running, cookie, "GET", "/api/v1/alarm/profiles")).body.profiles as Array<{ id: string }>;
    assert.ok(profiles.length >= 3, "the standard profiles are there");
    const names = profiles.map(item => item.id);
    for (const id of ["away", "stay", "night"]) assert.ok(names.includes(id), id);
    const saved = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: MODES, panel_map: { profiles: { away: "away", home: "stay", night: "night" } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.panel_map.profiles, { away: "away", home: "stay", night: "night" });
  } finally { await running.stop(); }
});

test("a panel that does not exist yet is saved, and at the first arming it is a failed panel with its alarm", async () => {
  const { running, cookie } = await prepared();
  try {
    const saved = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: MODES, panel_map: { only: ["ghost-panel"] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.panel_map.only, ["ghost-panel"]);
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "night" })).status, 200);
    const sync = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body.panel_sync;
    assert.equal(sync.status, "failed");
    assert.deepEqual(sync.nodes.map((node: { node_id: string; status: string; reason: string }) => [node.node_id, node.status, node.reason]), [["ghost-panel", "unavailable", "unknown_panel"]]);
    const open = running.app.context.alarms.active().filter(alarm => alarm.code === "mode_panel_sync_failed" && !alarm.cleared_at);
    assert.equal(open.length, 1, "one alarm, open while the report says failed");
    assert.equal(open[0]!.severity, "high");
    assert.ok(String(open[0]!.detail?.panel_answers).includes("ghost-panel"));
    // the panel appears and the same mode is asked again: the report no longer names a panel that is not there... when the list is fixed
    const fixed = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: MODES, revision: saved.body.revision, panel_map: { only: [] } });
    assert.equal(fixed.status, 200);
  } finally { await running.stop(); }
});

test("only an administrator saves the definitions, so only an administrator meets the check", async () => {
  const { running, cookie } = await prepared();
  try {
    const operator = await fetch(`${running.base}/api/v1/alarm/modes`, { method: "PUT", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` }, body: JSON.stringify({ modes: MODES, panel_map: { profiles: { night: "gone" } } }) });
    assert.ok([401, 403].includes(operator.status), String(operator.status));
    assert.equal((await call(running, cookie, "GET", "/api/v1/alarm/modes")).status, 200);
  } finally { await running.stop(); }
});
