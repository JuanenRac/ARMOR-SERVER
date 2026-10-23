import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { buildPanelSummary, createPanelFeed, MAX_PANEL_BUFFERED_BYTES, PANEL_HEARTBEAT_MS, type PanelSocket } from "../src/panel_feed.js";
import { SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const fakeSocket = (state = 1, buffered = 0): PanelSocket & { sent: string[]; terminated: boolean } => {
  const socket = { readyState: state, bufferedAmount: buffered, sent: [] as string[], terminated: false, send(data: string) { this.sent.push(data); }, terminate() { this.terminated = true; } };
  return socket;
};

test("the feed sends the summary when it changed, not when only the clock did, and sends it again when it is told to", () => {
  let mode = "disarmed", clock = 1000;
  const socket = fakeSocket();
  const feed = createPanelFeed(() => ({ mode, revision: 1, time_ms: clock }), () => [socket]);
  feed.push();
  assert.equal(socket.sent.length, 1, "the first look sends");
  clock += 500; feed.push();
  assert.equal(socket.sent.length, 1, "a later time alone is no change");
  mode = "armed"; feed.push();
  assert.equal(socket.sent.length, 2);
  const frame = JSON.parse(socket.sent[1]) as { type: string; heartbeat_ms: number; summary: { mode: string } };
  assert.equal(frame.type, "summary");
  assert.equal(frame.heartbeat_ms, PANEL_HEARTBEAT_MS);
  assert.equal(frame.summary.mode, "armed");
  feed.push(true);
  assert.equal(socket.sent.length, 3, "the heartbeat repeats the same summary");
});

test("a socket that just connected gets the summary, and that does not take it from the others", () => {
  let revision = 1;
  const first = fakeSocket();
  const sockets = [first];
  const feed = createPanelFeed(() => ({ mode: "armed", revision, time_ms: 1 }), () => sockets);
  feed.push();
  revision = 2;                                // changed, not sent yet
  const second = fakeSocket();
  sockets.push(second);
  feed.hello(second);
  assert.equal(second.sent.length, 1);
  feed.push();                                 // the first one still hears of the change
  assert.equal(first.sent.length, 2);
  assert.equal(second.sent.length, 2, "and so does the second, which already had it, as the feed does not track each socket");
});

test("nothing is built when nobody listens, and a socket that is closed or far behind is not written to", () => {
  let built = 0;
  const open = fakeSocket(), closed = fakeSocket(3), behind = fakeSocket(1, MAX_PANEL_BUFFERED_BYTES + 1);
  let sockets: PanelSocket[] = [];
  const feed = createPanelFeed(() => { built += 1; return { mode: "armed", revision: 1, time_ms: 1 }; }, () => sockets);
  feed.push();
  assert.equal(built, 0);
  sockets = [open, closed, behind];
  feed.push();
  assert.equal(open.sent.length, 1);
  assert.equal(closed.sent.length, 0);
  assert.equal(behind.sent.length, 0);
  assert.equal(behind.terminated, true, "one that cannot keep up is let go");
  assert.equal(closed.terminated, false);
});

test("a socket whose send throws is dropped, the others still get the summary", () => {
  const broken = { readyState: 1, bufferedAmount: 0, terminated: false, send() { throw new Error("gone"); }, terminate() { this.terminated = true; } };
  const good = fakeSocket();
  const feed = createPanelFeed(() => ({ mode: "armed", revision: 1, time_ms: 1 }), () => [broken, good]);
  feed.push();
  assert.equal(broken.terminated, true);
  assert.equal(good.sent.length, 1);
});

test("the summary of the live channel is the one of the route", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const route = await (await fetch(`${running.base}/api/v1/panel/summary`, { headers: { cookie } })).json() as Record<string, unknown>;
    const built = buildPanelSummary(running.app.context);
    const { time_ms: _a, ...fromRoute } = route;
    const { time_ms: _b, ...fromBuilder } = built;
    assert.deepEqual(fromBuilder, fromRoute);
  } finally { await running.stop(); }
});

const wsPort = (running: Running): number => Number(new URL(running.base).port);
const open = (running: Running, cookie: string, extra: Record<string, string> = {}) => new Promise<{ socket: WebSocket; frames: Array<Record<string, any>>; closed: Promise<number>; ok: boolean }>(resolve => {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort(running)}/api/v1/panel/events`, { headers: { cookie, ...extra } });
  const frames: Array<Record<string, any>> = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const closed = new Promise<number>(done => socket.on("close", code => done(code)));
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  socket.on("open", () => resolve({ socket, frames, closed, ok: true }));
  socket.on("error", () => resolve({ socket, frames, closed, ok: false }));
});
const waitFor = async (condition: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); };
const json = { "Content-Type": "application/json" };

test("a wall panel listens to the live channel: it gets the summary at once and again when the mode changes", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1", role: "panel" }) });
    assert.equal(made.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1" }) });
    const panel = (login.headers.getSetCookie()[0] ?? "").split(";")[0];

    const listening = await open(running, panel);
    assert.equal(listening.ok, true);
    await waitFor(() => listening.frames.length >= 1);
    assert.equal(listening.frames[0].type, "summary");
    assert.equal(listening.frames[0].summary.mode, "disarmed");
    assert.deepEqual(Object.keys(listening.frames[0]).sort(), ["heartbeat_ms", "summary", "type"], "no more than the summary and when to expect the next one");

    // the panel itself arms the house, as it always could: it hears the change without asking
    assert.equal((await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers: { ...json, cookie: panel }, body: JSON.stringify({ mode: "armed" }) })).status < 300, true);
    await waitFor(() => listening.frames.some(frame => frame.summary.mode === "armed"));
    assert.ok(listening.frames.some(frame => frame.summary.mode === "armed"), "the change reached the panel");

    // it only listens
    listening.socket.send("hello");
    assert.equal(await listening.closed, 1003);
  } finally { await running.stop(); }
});

test("the live channel is closed to strangers, to a viewer and to a page of another site", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    assert.equal((await open(running, "")).ok, false, "no session");
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "family", password: "family-password-123", role: "viewer" }) });
    assert.equal(made.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "family", password: "family-password-123" }) });
    const viewer = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    assert.equal((await open(running, viewer)).ok, false, "a viewer has no use for it");
    assert.equal((await open(running, admin, { Origin: "http://evil.example" })).ok, false, "not from a page of another site");
    const allowed = await open(running, admin);
    assert.equal(allowed.ok, true, "an administrator may");
    allowed.socket.terminate();
  } finally { await running.stop(); }
});

test("an administrator turns the live channel off: the panels on it are told and a new one is refused", async () => {
  assert.equal(SECURITY_DEFAULTS["panel.live_events"], true, "on by default: it shows nothing a panel cannot ask for");
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const listening = await open(running, admin);
    assert.equal(listening.ok, true);
    const changed = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "panel.live_events": false }) });
    assert.equal(changed.status, 200);
    assert.equal(await listening.closed, 4403);
    assert.equal((await open(running, admin)).ok, false);
    await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify({ "panel.live_events": true }) });
    const again = await open(running, admin);
    assert.equal(again.ok, true);
    again.socket.terminate();
  } finally { await running.stop(); }
});
