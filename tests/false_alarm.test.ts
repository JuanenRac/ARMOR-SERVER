// A person can say an alarm was a false alarm (or that it was not): administrators and operators only, audited, kept with the alarm, and counted by the summary of a day, which
// otherwise infers it from the disarm that ended an intrusion alarm. Written as a characterization of the inference first.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Alarm } from "../src/alarms.js";
import { dayOf } from "../src/day.js";
import { dailyEvents } from "../src/reports.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const MS = Date.parse("2026-03-05T10:00:00Z");
const at = (s: number) => new Date(MS + s * 1000).toISOString();
const door = (extra: Partial<Alarm> = {}): Alarm => ({ id: "a1", key: "k", source: { type: "device", id: "door-1" }, severity: "high", code: "door_open", raised_at: at(0), acknowledged_by: "disarm", cleared_at: at(10), ...extra });

test("characterization: with nobody saying anything the inference by the disarm is what decides, as it was", () => {
  const day = dayOf(MS);
  assert.equal(dailyEvents([door()], day, { falseAlarmS: 60 })[0]!.false_alarm, true);
  assert.equal(dailyEvents([door({ cleared_at: at(600) })], day, { falseAlarmS: 60 })[0]!.false_alarm, undefined);
  assert.equal(dailyEvents([door()], day, { falseAlarmS: 0 })[0]!.false_alarm, undefined);
});

test("a person's word beats the inference: marked is a false alarm whatever happened, not marked is not one even if a disarm ended it at once", () => {
  const day = dayOf(MS);
  assert.equal(dailyEvents([door({ cleared_at: at(600), acknowledged_by: "ana", false_alarm: true })], day, { falseAlarmS: 60 })[0]!.false_alarm, true);
  assert.equal(dailyEvents([door({ cleared_at: at(600), acknowledged_by: "ana", false_alarm: true })], day)[0]!.false_alarm, true, "also when nothing is inferred");
  assert.equal(dailyEvents([door({ false_alarm: false })], day, { falseAlarmS: 60 })[0]!.false_alarm, undefined);
});

async function accounts(running: Running, admin: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { admin };
  for (const role of ["operator", "viewer", "panel"]) {
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-123`, role }) });
    assert.equal(made.status, 201, role);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-123` }) });
    out[role] = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
  }
  return out;
}

test("route: administrators and operators mark it, everybody else is refused, it is audited and kept, and the summary counts it", async () => {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0" });
  try {
    const admin = await studioCookie(running.base);
    const who = await accounts(running, admin);
    const { alarms } = running.app.context;
    const made = alarms.raise("device:door-1:trigger", { source: { type: "device", id: "door-1" }, severity: "high", code: "door_open" })!;
    const mark = (cookie: string | undefined, id: string, payload?: unknown, extra: Record<string, string> = {}) => fetch(`${running.base}/api/v1/alarms/${id}/false-alarm`, { method: "POST", headers: { ...json, ...(cookie ? { cookie } : {}), ...extra }, body: payload === undefined ? "{}" : JSON.stringify(payload) });
    for (const [name, cookie, status] of [["viewer", who.viewer, 403], ["panel", who.panel, 403], ["nobody", undefined, 401]] as const) assert.equal((await mark(cookie, made.id)).status, status, name);
    assert.equal(alarms.kept()[0]!.false_alarm, undefined, "a refused request changes nothing");
    assert.equal((await mark(who.operator, made.id, { false_alarm: "yes" })).status, 400);
    assert.equal((await mark(admin, "ghost")).status, 404);
    const done = await mark(who.operator, made.id);
    assert.equal(done.status, 200);
    const body = (await done.json()) as Alarm;
    assert.deepEqual([body.false_alarm, body.false_alarm_by], [true, "u-operator"]);
    assert.equal((await mark(undefined, made.id, undefined, { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` })).status, 200, "the operator token is an operator");
    const listed = (await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie: admin } })).json()) as { active: Alarm[] };
    assert.equal(listed.active.find(item => item.id === made.id)!.false_alarm, true);
    assert.equal((await mark(admin, made.id, { false_alarm: false })).status, 200);
    assert.equal(alarms.kept()[0]!.false_alarm, false);
    assert.equal((await mark(admin, made.id, { false_alarm: null })).status, 200);
    assert.equal("false_alarm" in alarms.kept()[0]!, false, "taking the mark back leaves nothing");
    await mark(admin, made.id, { false_alarm: true });
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.doesNotMatch(audit, /"action":"alarm.false_alarm","outcome":"allowed","actor":"u-(viewer|panel)"/);
    assert.match(audit, /"action":"alarm.false_alarm","outcome":"allowed","actor":"u-operator"[^\n]*marked as a false alarm/);
    assert.match(audit, /mark taken back/);
    // kept on disk
    alarms.flush();
    const stored = JSON.parse(fs.readFileSync(path.join(running.config.dataDir, "alarms.json"), "utf8")) as { alarms: Alarm[] };
    assert.equal(stored.alarms.find(item => item.id === made.id)!.false_alarm, true);
    // the summary counts it
    assert.equal(dailyEvents(alarms.kept(), dayOf(Date.now())).find(event => event.code === "door_open")!.false_alarm, true);
  } finally { await running.stop(); }
});

test("route: a silent alarm cannot be marked by an operator, and the name of whoever marked it is cut", async () => {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0" });
  try {
    const admin = await studioCookie(running.base);
    const who = await accounts(running, admin);
    const { alarms } = running.app.context;
    const silent = alarms.raiseDuress("ana")!;
    const answer = await fetch(`${running.base}/api/v1/alarms/${silent.id}/false-alarm`, { method: "POST", headers: { ...json, cookie: who.operator }, body: "{}" });
    assert.equal(answer.status, 404, "it does not exist for an operator");
    assert.equal(alarms.markFalse("nope", true, "x"), undefined);
    const plain = alarms.raise("k2", { source: { type: "node", id: "radar-1" }, severity: "high", code: "intrusion" })!;
    assert.equal(alarms.markFalse(plain.id, true, "n".repeat(200))!.false_alarm_by!.length, 60);
  } finally { await running.stop(); }
});
