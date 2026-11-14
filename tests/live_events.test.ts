import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { LIVE_MAX_PENDING, LiveNotices, type LiveNotice } from "../src/live_events.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const json = { "content-type": "application/json" };

function manual(enabled = true) {
  const sent: LiveNotice[] = [];
  const queue: Array<() => void> = [];
  const live = new LiveNotices({ enabled: () => enabled, timers: { set: callback => { queue.push(callback); return queue.length; }, clear: () => undefined } });
  live.attach(notice => { sent.push(notice); });
  return { live, sent, tick: () => { const callbacks = queue.splice(0); for (const callback of callbacks) callback(); } };
}

test("a notice carries a type, an id and a version, and a burst about the same thing is one notice", () => {
  const { live, sent, tick } = manual();
  live.notify("alarm", "alm-00001");
  live.notify("alarm", "alm-00001");
  live.notify("device", "lamp");
  assert.equal(sent.length, 0, "kept for a moment");
  tick();
  assert.deepEqual(sent.map(item => `${item.type}:${item.id}`), ["alarm:alm-00001", "device:lamp"]);
  assert.equal(sent[0].version, 2, "the newest of the two");
  assert.ok(sent[1].version > sent[0].version);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["id", "type", "version"], "nothing else travels");
});

test("a design notice carries the revision that was saved", () => {
  const { live, sent, tick } = manual();
  live.notify("design", "site", 7);
  tick();
  assert.deepEqual(sent, [{ type: "design", id: "site", version: 7 }]);
});

test("nothing is sent when the option is off or nobody is attached, and a long id is cut", () => {
  const off = manual(false);
  off.live.notify("solar", "a/b");
  off.tick();
  assert.deepEqual(off.sent, []);
  const none = new LiveNotices({ enabled: () => true });
  none.notify("solar", "a/b");
  none.flush();
  none.close();
  const { live, sent, tick } = manual();
  live.notify("network", "x".repeat(500));
  tick();
  assert.equal(sent[0].id.length, 64);
});

test("a storm of different things is sent at once, not kept without a limit, and a failing socket does not stop the rest", () => {
  const sent: string[] = [];
  const live = new LiveNotices({ enabled: () => true, timers: { set: () => 1, clear: () => undefined } });
  let failures = 0;
  live.attach(notice => { if (notice.id === "d0") { failures += 1; throw new Error("socket gone"); } sent.push(notice.id); });
  for (let index = 0; index < LIVE_MAX_PENDING; index += 1) live.notify("device", `d${index}`);
  assert.equal(failures, 1);
  assert.equal(sent.length, LIVE_MAX_PENDING - 1);
  live.close();
});

test("the option is on by default and turning it off is not a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["live.events"], true);
  assert.equal(lowers("live.events", true, false), false);
});

type Socket = { socket: WebSocket; messages: Array<Record<string, unknown>> };
async function listen(running: Running, cookie: string): Promise<Socket> {
  const socket = new WebSocket(`${running.base.replace("http", "ws")}/api/v1/events`, { headers: { cookie } });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", data => { messages.push(JSON.parse(String(data)) as Record<string, unknown>); });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  return { socket, messages };
}
const until = async (check: () => boolean): Promise<void> => { for (let index = 0; index < 100 && !check(); index += 1) await new Promise(resolve => setTimeout(resolve, 30)); };

test("an alarm, a design and a solar reading reach a console of the live channel as notices, without a detail", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const { socket, messages } = await listen(running, admin);
    const alarm = running.app.context.alarms.raise("test:live", { source: { type: "node", id: "radar-x" }, severity: "high", code: "intrusion", detail: { secret_looking: "must not travel" } });
    assert.ok(alarm);
    const saved = await fetch(`${running.base}/api/v1/site`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ revision: 0, site: { terrain: { points: [] }, note: "a" } }) });
    assert.equal(saved.status, 200);
    await until(() => messages.some(item => item.type === "alarm") && messages.some(item => item.type === "design"));
    const notice = messages.find(item => item.type === "alarm");
    assert.deepEqual({ type: notice?.type, id: notice?.id }, { type: "alarm", id: alarm.id });
    assert.deepEqual(Object.keys(notice ?? {}).sort(), ["id", "type", "version"]);
    assert.equal(JSON.stringify(messages).includes("must not travel"), false);
    const design = messages.find(item => item.type === "design");
    assert.equal(design?.id, "site");
    assert.equal(design?.version, 1, "the revision that was saved");
    socket.terminate();
  } finally { await running.stop(); }
});

test("a silent alarm is never announced, and with the option off the channel carries the state only", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const { socket, messages } = await listen(running, admin);
    running.app.context.alarms.raiseDuress("someone");
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(messages.some(item => item.type === "alarm"), false, "a silent alarm is told to nobody on the console");
    const off = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "live.events": false }) });
    assert.equal(off.status, 200);
    running.app.context.alarms.raise("test:off", { source: { type: "node", id: "radar-y" }, severity: "high", code: "intrusion" });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(messages.some(item => item.type === "alarm"), false);
    socket.terminate();
  } finally { await running.stop(); }
});
