import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AlarmCentre } from "../src/alarms.js";
import { skipUsers, type NotifyChannel } from "../src/channels.js";
import { DuressLog } from "../src/duress_log.js";
import { SessionStore } from "../src/http/auth.js";
import { AlertNotifier, alertMessageFor, type AlertMessage } from "../src/notify.js";
import { createPanelFeed, type PanelSocket } from "../src/panel_feed.js";
import { FcmDevices, fcmChannel, type FcmServiceAccount } from "../src/push_fcm.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "content-type": "application/json" };
const tempFile = (name: string): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-duress-")), name);

type Row = Record<string, unknown>;
type Session = { id: string; role: string; headers: Record<string, string> };

/** An administrator with a PIN and a duress PIN, an operator and a wall panel, each with a session of their own, and a second session of the administrator. */
async function house(running: Running, hide: boolean): Promise<{ admin: Session; adminB: Session; operator: Session; panel: Session }> {
  const cookie = await studioCookie(running.base);
  const headers = { ...json, cookie };
  if (hide) assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "alarm.duress_hide_trail": true }) })).status, 200);
  const users = ((await (await fetch(`${running.base}/api/v1/users`, { headers })).json()) as { users: Array<{ id: string; username: string }> }).users;
  const adminId = users[0]!.id;
  assert.equal((await fetch(`${running.base}/api/v1/users/${adminId}/pin`, { method: "PUT", headers, body: JSON.stringify({ pin: "2468", duress_pin: "1357" }) })).status, 200);
  const make = async (username: string, role: string): Promise<Session> => {
    const password = `${username}-password-1234`;
    const created = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers, body: JSON.stringify({ username, password, role }) });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { id: string }).id;
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 201);
    return { id, role, headers: { ...json, cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0]! } };
  };
  const second = await studioCookie(running.base);
  return { admin: { id: adminId, role: "admin", headers }, adminB: { id: adminId, role: "admin", headers: { ...json, cookie: second } }, operator: await make("guard-1", "operator"), panel: await make("wall-panel", "panel") };
}

const post = (running: Running, session: Session, route: string, body: unknown) => fetch(`${running.base}${route}`, { method: "POST", headers: session.headers, body: JSON.stringify(body) });
const get = async (running: Running, session: Session, route: string): Promise<{ status: number; body: Row }> => { const answer = await fetch(`${running.base}${route}`, { headers: session.headers }); return { status: answer.status, body: (await answer.json().catch(() => ({}))) as Row }; };
const auditLines = async (running: Running, session: Session): Promise<Row[]> => (await get(running, session, "/api/v1/audit?limit=500")).body.entries as Row[];
const disarmLines = (lines: Row[]): Row[] => lines.filter(line => line.action === "control.disarm");
const withoutTime = (line: Row): string => { const { at: _at, ...rest } = line; return JSON.stringify(rest); };
const activeOf = async (running: Running, session: Session): Promise<Row[]> => ((await get(running, session, "/api/v1/alarms")).body.active ?? []) as Row[];
const panelItems = async (running: Running, session: Session): Promise<Row[]> => (((await get(running, session, "/api/v1/panel/summary")).body.alarms as { items: Row[] }).items);

test("with the option on, a normal disarm and a duress disarm leave the same line in the audit trail and the same event in the history", async () => {
  const running = await startServer();
  try {
    const { admin } = await house(running, true);
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "armed" })).status, 200);
    const normal = await post(running, admin, "/api/v1/mode", { mode: "disarmed", pin: "2468" });
    assert.equal(normal.status, 200);
    const normalBody = await normal.json() as Row;
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "armed" })).status, 200);
    const forced = await post(running, admin, "/api/v1/mode", { mode: "disarmed", pin: "1357" });
    assert.equal(forced.status, 200);
    const forcedBody = await forced.json() as Row;

    const lines = disarmLines(await auditLines(running, admin));
    assert.equal(lines.length, 2);
    assert.equal(withoutTime(lines[0]!), withoutTime(lines[1]!), "the same action, outcome, actor and detail, byte for byte");
    assert.ok(!JSON.stringify(lines).includes("duress"));
    // what the session that disarmed is told is the same too
    assert.equal(forcedBody.mode, normalBody.mode);
    assert.deepEqual(Object.keys(forcedBody).sort(), Object.keys(normalBody).sort());
    // the history reads it as an ordinary disarm
    const history = ((await get(running, admin, "/api/v1/history?type=system&category=alarm")).body.events as Row[]).filter(event => event.action === "disarmed");
    assert.equal(history.length, 2);
    assert.equal(withoutTime({ ...history[0]!, id: 0 }), withoutTime({ ...history[1]!, id: 0 }));
    // and the difference is in the record apart
    const record = (await get(running, admin, "/api/v1/alarm/duress-log")).body as { count: number; entries: Array<{ via: string; actor: string }> };
    assert.equal(record.count, 1);
    assert.equal(record.entries[0]!.via, "mode_pin");
    assert.equal(record.entries[0]!.actor, "admin");
  } finally { await running.stop(); }
});

test("with the option off (the default) a duress disarm is recorded as it always was, and only an administrator sees the alarm", async () => {
  const running = await startServer();
  try {
    const { admin, operator, panel } = await house(running, false);
    assert.equal(SECURITY_DEFAULTS["alarm.duress_hide_trail"], false);
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "armed" })).status, 200);
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "disarmed", pin: "1357" })).status, 200);
    const lines = disarmLines(await auditLines(running, admin));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.detail, "duress");
    assert.equal((await activeOf(running, admin)).length, 1, "an administrator signed in to Studio sees it, as before");
    assert.equal((await activeOf(running, operator)).length, 0);
    assert.equal((await panelItems(running, panel)).length, 0);
    assert.equal((await get(running, admin, "/api/v1/alarm/duress-log")).body.count, 1, "the record is kept either way");
  } finally { await running.stop(); }
});

test("with the option on the alarm is shown on the wall panel and to every other session, never to the session that disarmed", async () => {
  const running = await startServer();
  try {
    const { admin, adminB, operator, panel } = await house(running, true);
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "armed" })).status, 200);
    assert.equal((await post(running, admin, "/api/v1/mode", { mode: "disarmed", pin: "1357" })).status, 200);

    // the session that disarmed sees an ordinary disarmed system: no alarm in the list, none in the summary
    assert.equal((await get(running, admin, "/api/v1/status")).body.mode, "disarmed");
    assert.deepEqual(await activeOf(running, admin), []);
    assert.deepEqual(await panelItems(running, admin), []);
    assert.deepEqual(((await get(running, admin, "/api/v1/alarms")).body.recent ?? []) as Row[], []);

    // the wall panel, another session of the same administrator and an operator are told
    const onPanel = await panelItems(running, panel);
    assert.equal(onPanel.length, 1);
    assert.equal(onPanel[0]!.code, "duress_disarm");
    assert.equal(onPanel[0]!.severity, "critical");
    assert.equal((await activeOf(running, adminB)).length, 1);
    assert.equal((await activeOf(running, operator)).length, 1);
    const id = String((await activeOf(running, operator))[0]!.id);
    // only an administrator acts on it: an operator cannot acknowledge what is not theirs to close
    assert.equal((await post(running, operator, `/api/v1/alarms/${id}/acknowledge`, {})).status, 404);
    assert.equal((await post(running, adminB, `/api/v1/alarms/${id}/acknowledge`, {})).status, 200);
    // the wall panel's acknowledge-all does not take it either
    assert.equal(((await (await post(running, panel, "/api/v1/alarms/acknowledge", {})).json()) as Row).acknowledged, 0);
    // never in the history that every console reads
    const events = (await get(running, operator, "/api/v1/history?type=alarm")).body.events as Row[];
    assert.ok(!events.some(event => String(event.code ?? "") === "duress_disarm"));
  } finally { await running.stop(); }
});

test("the record of duress is for an administrator only, whatever the option", async () => {
  const running = await startServer();
  try {
    const { admin, operator, panel } = await house(running, true);
    assert.equal((await get(running, admin, "/api/v1/alarm/duress-log")).status, 200);
    assert.equal((await get(running, operator, "/api/v1/alarm/duress-log")).status, 403);
    assert.equal((await get(running, panel, "/api/v1/alarm/duress-log")).status, 403);
    assert.equal((await fetch(`${running.base}/api/v1/alarm/duress-log`)).status, 401);
    assert.ok([401, 403].includes((await fetch(`${running.base}/api/v1/alarm/duress-log`, { headers: { authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).status), "a token is refused");
  } finally { await running.stop(); }
});

test("turning the option off is a loss of protection and is the default off", () => {
  assert.equal(lowers("alarm.duress_hide_trail", true, false), true);
  assert.equal(lowers("alarm.duress_hide_trail", false, true), false);
});

test("a session is kept from seeing an alarm only while it stands, through a restart", () => {
  const file = tempFile("sessions.json");
  const make = () => new SessionStore({ cookieName: "sid", cookiePath: "/", ttlMs: 3_600_000, secure: false, file });
  const store = make();
  let cookie = "";
  const response = { cookie: (_name: string, value: string) => { cookie = value; }, clearCookie: () => undefined } as never;
  store.open(response, "u-1");
  const request = { header: (name: string) => (name.toLowerCase() === "cookie" ? `sid=${cookie}` : undefined) };
  assert.equal(store.hiddenAlarms(request).size, 0);
  assert.equal(store.hideAlarm(request, "alm-00001"), true);
  assert.deepEqual([...store.hiddenAlarms(request)], ["alm-00001"]);
  store.flush();
  assert.deepEqual([...make().hiddenAlarms(request)], ["alm-00001"], "it survives a restart of the server");
  assert.equal(store.hideAlarm({ header: () => undefined }, "alm-00002"), false, "no session, nothing to hide from");
  assert.equal(store.hiddenAlarms({ header: () => undefined }).size, 0);
  for (let index = 0; index < 40; index += 1) store.hideAlarm(request, `alm-${index}`);
  assert.ok(store.hiddenAlarms(request).size <= 16, "bounded");
});

test("a silent alarm is on the lists only of those it is shown to, and a session can be left out", () => {
  const centre = new AlarmCentre({ file: tempFile("alarms.json") });
  const hidden = centre.raiseDuress("ana", { shown: false })!;
  assert.equal(hidden.shown, undefined);
  assert.deepEqual(centre.active({ shown: true }), [], "not shown: nobody but an administrator");
  assert.equal(centre.active({ silent: true }).length, 1);
  const other = new AlarmCentre({ file: tempFile("alarms.json") });
  const mine = other.raiseDuress("ana", { shown: true })!;
  assert.equal(mine.shown, true);
  assert.equal(other.active({ shown: true }).length, 1);
  assert.equal(other.active({ shown: true, hidden: new Set([mine.id]) }).length, 0);
  assert.equal(other.active({ silent: true, hidden: new Set([mine.id]) }).length, 0, "an administrator's session that disarmed is kept from it too");
  assert.equal(other.active().length, 0, "the default lists, the escalation and the voice never carry it");
  assert.equal(other.kept().length, 0, "nor does a report");
  assert.equal(other.acknowledge(mine.id, "operator"), undefined, "and an operator cannot close it");
});

test("the record of duress keeps the count past its limit and survives a restart", () => {
  const file = tempFile("duress-log.json");
  const log = new DuressLog(file);
  for (let index = 0; index < 230; index += 1) log.add(`user-${index}`, index % 2 ? "pin" : "voice_pin", `alm-${index}`);
  const view = new DuressLog(file).view();
  assert.equal(view.count, 230);
  assert.equal(view.entries.length, 200);
  assert.equal(view.entries[0]!.actor, "user-229", "newest first");
  assert.equal(JSON.stringify(Object.keys(view.entries[0]!)), JSON.stringify(["at", "actor", "via", "alarm_id"]));
  assert.equal(fs.statSync(file).size > 0, true);
});

test("the phones of the person who disarmed are left out of the silent push, and the place is used only when the option is on", async () => {
  const got: Array<{ id: string; skipped: boolean }> = [];
  const channel = (id: "telegram" | "fcm", extra: Partial<NotifyChannel>): NotifyChannel => ({ id, ...extra, deliver: async message => { got.push({ id, skipped: skipUsers.get(message)?.has("ana") === true }); return { ok: true, detail: "" }; } });
  let on = false;
  const notifier = new AlertNotifier({
    audit: { record: () => undefined } as never, retryDelaysMs: [], silentPush: () => on,
    channels: [channel("telegram", { quiet: true }), channel("fcm", { pushesSilent: true })],
  });
  const message = alertMessageFor({ type: "alarm", id: 0, at: new Date().toISOString(), alarm_id: "alm-1", state: "raised", severity: "critical", source: "duress", source_type: "alarm", code: "duress_disarm", silent: true }, "disarmed")!;
  notifier.send({ ...message });
  await notifier.idle();
  assert.deepEqual(got.map(item => item.id), ["telegram"], "option off: as it always was");
  got.length = 0; on = true;
  notifier.send({ ...message }, { skipUsers: new Set(["ana"]) });
  await notifier.idle();
  assert.deepEqual(got.map(item => item.id).sort(), ["fcm", "telegram"]);
  assert.equal(got.find(item => item.id === "fcm")?.skipped, true, "the channel is told whose phones to leave out");
});

test("the push channel does not reach the phones of the people it is told to skip", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account: FcmServiceAccount = { project_id: "armor-test-1", client_email: "push@armor-test-1.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" };
  const devices = new FcmDevices(tempFile("devices.json"));
  const mine = "a".repeat(30) + ":APA91bMine", theirs = "b".repeat(30) + ":APA91bTheirs";
  devices.add(mine, "ana");
  devices.add(theirs, "ben");
  const sentTo: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === account.token_uri) return new Response(JSON.stringify({ access_token: "ya29.t", expires_in: 3600 }), { status: 200 });
    sentTo.push((JSON.parse(String(init?.body)) as { message: { token: string } }).message.token);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const channel = fcmChannel({ account, devices, fetchImpl, now: () => 5_000_000 });
  const message = { event: "alarm.raised", severity: "critical", silent: true } as unknown as AlertMessage;
  skipUsers.set(message, new Set(["ana"]));
  assert.equal((await channel.deliver(message, "text", "en", AbortSignal.timeout(5000))).ok, true);
  assert.deepEqual(sentTo, [theirs]);
  assert.equal(channel.pushesSilent, true);
});

test("the wall panel feed builds one summary for the sockets that see the same and another for the one kept from an alarm", () => {
  const sent = new Map<number, string[]>();
  const socket = (index: number): PanelSocket => { sent.set(index, []); return { readyState: 1, bufferedAmount: 0, send: text => { sent.get(index)!.push(text); }, terminate: () => undefined }; };
  const sockets = [socket(1), socket(2), socket(3)];
  const hiddenOf = (client: PanelSocket): ReadonlySet<string> => (client === sockets[2] ? new Set(["alm-00001"]) : new Set());
  let built = 0;
  const feed = createPanelFeed(hidden => { built += 1; return { mode: "disarmed", revision: 1, time_ms: 1, alarms: { items: hidden.has("alm-00001") ? [] : [{ id: "alm-00001" }] } }; }, () => sockets, hiddenOf);
  feed.push();
  assert.equal(built, 2, "one for the two sockets that see the alarm, one for the third");
  assert.ok(sent.get(1)![0]!.includes("alm-00001") && sent.get(2)![0]!.includes("alm-00001"));
  assert.ok(!sent.get(3)![0]!.includes("alm-00001"));
  feed.push();
  assert.equal(sent.get(1)!.length, 1, "unchanged: nothing is sent again");
  feed.hello(sockets[2]!);
  assert.ok(!sent.get(3)!.at(-1)!.includes("alm-00001"), "a panel that connects later is told the same as the one before it");
});
