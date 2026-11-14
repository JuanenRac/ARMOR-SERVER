// The hidden panic gesture of the apps: a signed-in person asks for help without anything showing. Off by default (404), the same answer whether an alarm was raised or not, once per quiet time.
import assert from "node:assert/strict";
import test from "node:test";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";

const json = { "Content-Type": "application/json" };
const gesture = (running: Running, headers: Record<string, string>) => fetch(`${running.base}/api/v1/alarm/panic-gesture`, { method: "POST", headers: { ...json, ...headers }, body: "{}" })
  .then(async reply => ({ status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, unknown> }));
const setting = (running: Running, cookie: string, change: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify(change) });
/** Counts the silent alarms the centre is asked to raise (a silent alarm is told to the places nobody can see and is not on the list a console reads). */
const watch = (running: Running): { raised: string[] } => {
  const centre = running.app.context.alarms, original = centre.raiseDuress.bind(centre), seen: { raised: string[] } = { raised: [] };
  centre.raiseDuress = who => { seen.raised.push(who); return original(who); };
  return seen;
};

test("the option is off by default and turning it on is not a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["client.panic_gesture"], false);
  assert.equal(lowers("client.panic_gesture", false, true), false);
  assert.equal(lowers("client.panic_gesture", true, false), false);
});

test("while the option is off the route answers 404 as if it did not exist, and nothing is raised", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const reply = await gesture(running, { Cookie: cookie });
    assert.equal(reply.status, 404);
    assert.equal(running.app.context.alarms.active().length, 0);
  } finally { await running.stop(); }
});

test("on, the gesture raises the silent alarm, the answer says nothing, the mode is untouched and the trail has the fact", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await setting(running, cookie, { "client.panic_gesture": true })).status, 200);
    const seen = watch(running);
    const mode = running.app.context.store.snapshot().mode;
    const reply = await gesture(running, { Cookie: cookie });
    assert.deepEqual({ status: reply.status, body: reply.body }, { status: 200, body: { ok: true } });
    assert.deepEqual(seen.raised, [SECRETS.ARMOR_STUDIO_USERNAME], "the silent alarm is raised for the person");
    assert.equal(running.app.context.alarms.active().length, 0, "and it shows on no list a console reads");
    assert.equal(running.app.context.store.snapshot().mode, mode, "the mode is not touched");
  } finally { await running.stop(); }
});

test("a second gesture inside the quiet time raises nothing more and is answered the same", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.panic_gesture": true });
    const seen = watch(running);
    const first = await gesture(running, { Cookie: cookie });
    const second = await gesture(running, { Cookie: cookie });
    assert.deepEqual(second, first, "the same answer");
    assert.equal(seen.raised.length, 1, "one alarm for the two gestures");
  } finally { await running.stop(); }
});

test("a service token, or nobody, cannot do it: only a person with a session", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "client.panic_gesture": true });
    const seen = watch(running);
    assert.equal((await gesture(running, {})).status, 401, "no session");
    assert.equal((await gesture(running, { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` })).status, 403, "the operator token of a service is not a person");
    assert.deepEqual(seen.raised, []);
  } finally { await running.stop(); }
});
