import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway, FRAME_BYTES, parseActivityEvent } from "../src/ai.js";
import { SECRETS, startServer, type Running } from "./helpers.js";

// The route of the activity events of the vision service under abuse: no token, a wrong token, a body that is too big or is not JSON, a camera that does not exist, a zone of another kind,
// a flood. Nothing here may raise an alarm that the contract does not allow, and nothing may answer with a server error.

const AI_TOKEN = "a".repeat(32);
const URL = "/api/v1/ai/activity-events";
const json = { "Content-Type": "application/json" };

type Answer = { status: number; body: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any

const send = async (running: Running, init: { method?: string; url?: string; headers?: Record<string, string>; raw?: string }): Promise<Answer> => {
  const reply = await fetch(`${running.base}${init.url ?? URL}`, { method: init.method ?? "POST", headers: init.headers ?? {}, body: init.raw });
  let body: Record<string, any> = {};   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(await reply.text()); } catch { /* not JSON */ }
  return { status: reply.status, body };
};
const post = (running: Running, body: unknown, bearer: string | null = AI_TOKEN): Promise<Answer> =>
  send(running, { headers: { ...json, ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }) }, raw: JSON.stringify(body) });

const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret-pw", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };
const square = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const zones = [
  { id: "drive", name: "Driveway", points: square, kind: "alert", labels: [], min_frames: 1, min_seconds: 0 },
  { id: "garden", name: "Garden", points: square, kind: "detection", labels: [], min_frames: 1, min_seconds: 0 },
];
const enter = { schema: "armor.vision.activity/v1", type: "zone_enter", camera_id: "cam-gate", track_id: 3, label: "person", timestamp: 12.5, timestamp_ms: 12500, authorizes_action: false, zone_id: "drive", zone_name: "Driveway" };

async function withServer(run: (running: Running, audit: Array<Record<string, unknown>>) => Promise<void>, turnOn = true): Promise<void> {
  const fake = new AiGateway({ ffmpegPath: "/usr/bin/ffmpeg", run: async () => Buffer.alloc(FRAME_BYTES, 9) });
  const audit: Array<Record<string, unknown>> = [];
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN }, { ai: fake, audit: { record: event => { audit.push({ ...event }); } } });
  try {
    const configured = await send(running, { headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` }, url: "/api/v1/cameras/configure", raw: JSON.stringify(camera) });
    assert.ok(configured.status < 300, `configure: ${configured.status}`);
    running.app.context.detectionZones.set("cam-gate", { zones, profiles: {} });
    if (turnOn) running.app.context.securitySettings.update({ "vision.activity_events": true });
    audit.length = 0;
    await run(running, audit);
  } finally { await running.stop(); }
}

const taken = (audit: Array<Record<string, unknown>>) => audit.filter(entry => entry.action === "ai.activity_event" && entry.outcome === "allowed");

test("a request without the token of the observation service never reaches the event, whatever it carries", async () => {
  await withServer(async (running, audit) => {
    running.app.context.store.arm("armed");
    const wrong = "b".repeat(32);
    for (const bearer of [null, "", " ", wrong, AI_TOKEN + "x", AI_TOKEN.slice(1), AI_TOKEN.toUpperCase(), SECRETS.ARMOR_OPERATOR_TOKEN]) {
      assert.equal((await post(running, { ...enter, notify: true }, bearer)).status, 401, String(bearer));
    }
    for (const authorization of [`Basic ${Buffer.from(`ai:${AI_TOKEN}`).toString("base64")}`, `Token ${AI_TOKEN}`, AI_TOKEN]) {
      assert.equal((await send(running, { headers: { ...json, Authorization: authorization }, raw: JSON.stringify(enter) })).status, 401, authorization);
    }
    assert.equal((await send(running, { url: `${URL}?token=${AI_TOKEN}`, headers: json, raw: JSON.stringify(enter) })).status, 401, "a token in the address is not a token");
    assert.equal(running.app.context.alarms.active().length, 0);
    assert.deepEqual(taken(audit), []);
  });
});

test("a body that is too big, broken or not an object is refused with a client error and raises nothing", async () => {
  await withServer(async (running, audit) => {
    running.app.context.store.arm("armed");
    const headers = { ...json, Authorization: `Bearer ${AI_TOKEN}` };
    const refusals: Array<[string, string]> = [
      ["broken", '{"schema":"armor.vision.activity/v1","type":'], ["empty", ""], ["a bare word", "hello"], ["null", "null"], ["a number", "42"], ["a text", '"zone_enter"'],
      ["a list", JSON.stringify([enter])], ["an empty list", "[]"], ["a huge text", JSON.stringify({ ...enter, label: "x".repeat(70_000) })],
      ["a huge body", JSON.stringify({ ...enter, padding: "y".repeat(200_000) })], ["deep", `${"[".repeat(5000)}${"]".repeat(5000)}`],
    ];
    for (const [name, raw] of refusals) {
      const answer = await send(running, { headers, raw });
      assert.ok(answer.status >= 400 && answer.status < 500, `${name}: ${answer.status}`);
    }
    const plain = await send(running, { headers: { "Content-Type": "text/plain", Authorization: `Bearer ${AI_TOKEN}` }, raw: JSON.stringify({ ...enter, notify: true }) });
    assert.equal(plain.status, 422, "a body that is not declared as JSON is not read");
    const form = await send(running, { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${AI_TOKEN}` }, raw: "type=zone_enter&camera_id=cam-gate" });
    assert.equal(form.status, 422);
    assert.equal(running.app.context.alarms.active().length, 0);
    assert.deepEqual(taken(audit), []);
  });
});

test("a member that is not in the contract is refused, however it is spelled, and nothing leaks into the prototypes", async () => {
  await withServer(async (running) => {
    running.app.context.store.arm("armed");
    const headers = { ...json, Authorization: `Bearer ${AI_TOKEN}` };
    const base = JSON.stringify(enter).slice(1, -1);
    for (const extra of ['"__proto__":{"polluted":true}', '"constructor":{"prototype":{"polluted":true}}', '"picture":"AAAA"', '"box":[0,0,1,1]', '"notify ":true', '"Notify":true', '"seconds":null']) {
      const answer = await send(running, { headers, raw: `{${base},${extra}}` });
      assert.equal(answer.status, 422, extra);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(running.app.context.alarms.active().length, 0);
  });
});

test("an invalid value of a member the contract names is refused", async () => {
  await withServer(async (running) => {
    running.app.context.store.arm("armed");
    const bad: Array<Record<string, unknown>> = [
      { track_id: 1.5 }, { track_id: -1 }, { track_id: Number.MAX_SAFE_INTEGER + 1 }, { track_id: 1e300 }, { track_id: "3" }, { track_id: null }, { timestamp: "12" }, { timestamp: null }, { timestamp_ms: 1.5 }, { timestamp_ms: -1 },
      { label: "x".repeat(61) }, { label: 5 }, { label: null }, { label: ["person"] }, { zone_id: "z".repeat(81) }, { zone_id: 7 }, { zone_id: "" }, { zone_name: "n".repeat(121) }, { zone_name: "" },
      { notify: 0 }, { notify: "false" }, { notify: null }, { authorizes_action: "false" }, { authorizes_action: null }, { authorizes_action: 0 }, { camera_id: "ab" }, { camera_id: "c".repeat(81) },
      { camera_id: "cam gate" }, { camera_id: "../cam-gate" }, { camera_id: "cam-gate\n" }, { camera_id: "cám-gate" }, { schema: undefined }, { type: "ZONE_ENTER" }, { type: "dwell", seconds: -1 },
      { type: "dwell", seconds: 86_400 * 7 + 1 }, { type: "dwell", seconds: "5" }, { type: "loiter", seconds: Number.NaN },
    ];
    for (const change of bad) {
      const answer = await post(running, { ...enter, ...change });
      assert.equal(answer.status, 422, JSON.stringify(change));
    }
    assert.equal(running.app.context.alarms.active().length, 0);
  });
});

test("the largest track number that a JSON reader keeps exactly is taken and the next one is not", async () => {
  await withServer(async (running) => {
    assert.equal((await post(running, { ...enter, track_id: Number.MAX_SAFE_INTEGER })).status, 200);
    assert.equal((await post(running, { ...enter, track_id: Number.MAX_SAFE_INTEGER + 1 })).status, 422);
  });
  assert.ok(parseActivityEvent({ ...enter, track_id: Number.MAX_SAFE_INTEGER }));
  assert.equal(parseActivityEvent({ ...enter, track_id: Number.MAX_SAFE_INTEGER + 1 }), undefined);
});

test("a camera the server does not know is told so, with the case and the spelling of the name respected", async () => {
  await withServer(async (running, audit) => {
    running.app.context.store.arm("armed");
    for (const id of ["cam-nope", "CAM-GATE", "cam-gate.", "cam-gat", "cam_gate", "cam-gate-2"]) {
      const answer = await post(running, { ...enter, notify: true, camera_id: id });
      assert.equal(answer.status, 404, id);
      assert.deepEqual(answer.body, { error: "unknown_camera" });
    }
    assert.equal(running.app.context.alarms.active().length, 0);
    assert.deepEqual(taken(audit), []);
  });
});

test("only an entry, a stay or a loitering in a zone of kind alert, told and armed, raises an alarm", async () => {
  await withServer(async (running, audit) => {
    const context = running.app.context;
    const recorded = { raised: false, reason: "recorded" };
    // every event of a zone of kind detection, an exit and a line are recorded, armed or not
    context.store.arm("armed");
    for (const type of ["zone_enter", "dwell", "loiter"]) {
      const seconds = type === "zone_enter" ? {} : { seconds: 30 };
      assert.deepEqual((await post(running, { ...enter, type, ...seconds, zone_id: "garden", notify: true })).body, recorded, type);
    }
    assert.deepEqual((await post(running, { ...enter, type: "zone_exit", seconds: 3, notify: true })).body, recorded);
    for (const direction of ["to_left", "to_right"]) {
      const { zone_id: _zone, zone_name: _name, ...rest } = enter;
      assert.deepEqual((await post(running, { ...rest, type: "line_cross", line_id: "gate", direction, notify: true })).body, recorded, direction);
    }
    // a zone the server does not hold (the names of the prototypes among them) is recorded and never crashes it
    for (const zone_id of ["__proto__", "constructor", "toString", "hasOwnProperty", "from-the-config", "DRIVE", "drive "]) {
      assert.deepEqual((await post(running, { ...enter, zone_id, notify: true })).body, recorded, zone_id);
    }
    assert.equal(context.alarms.active().length, 0);
    assert.ok(taken(audit).length >= 12, "every one of them was recorded");
    // notify:false is answered before the mode is looked at, and wins over everything below it
    context.store.arm("disarmed");
    assert.deepEqual((await post(running, { ...enter, notify: false })).body, { raised: false, reason: "notify_off" });
    assert.deepEqual((await post(running, enter)).body, { raised: false, reason: "disarmed" });
    assert.equal(context.alarms.active().length, 0);
    context.store.arm("armed");
    for (const type of ["dwell", "loiter"]) {
      assert.equal((await post(running, { ...enter, type, seconds: 5, track_id: type === "dwell" ? 11 : 12 })).status, 200);
    }
    assert.equal(context.alarms.active().length, 1, "a second one of the same zone in the same window joins the open alarm");
  });
});

test("a flood of events raises one alarm and a flood with the option off raises none", async () => {
  await withServer(async (running, audit) => {
    running.app.context.store.arm("armed");
    const answers = await Promise.all(Array.from({ length: 120 }, (_, index) => post(running, { ...enter, notify: true, track_id: index + 1 })));
    assert.ok(answers.every(answer => answer.status === 200), "no server error under a flood");
    assert.equal(answers.filter(answer => answer.body.raised === true).length, 1);
    assert.equal(running.app.context.alarms.active().length, 1);
    assert.equal(taken(audit).length, 120);
  });
  await withServer(async (running, audit) => {
    running.app.context.store.arm("armed");
    const answers = await Promise.all(Array.from({ length: 120 }, (_, index) => post(running, { ...enter, notify: true, track_id: index + 1 })));
    assert.ok(answers.every(answer => answer.status === 200 && answer.body.reason === "feature_off"));
    assert.equal(running.app.context.alarms.active().length, 0);
    assert.deepEqual(taken(audit), []);
    assert.ok(audit.filter(entry => entry.action === "ai.activity_event").every(entry => entry.outcome === "denied"));
  }, false);
});

test("an anonymous client that keeps asking is slowed down before it can do harm", async () => {
  await withServer(async (running) => {
    running.app.context.store.arm("armed");
    const statuses: number[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const answers = await Promise.all(Array.from({ length: 100 }, () => post(running, enter, "b".repeat(32))));
      statuses.push(...answers.map(answer => answer.status));
    }
    assert.ok(statuses.every(status => status === 401 || status === 429), "never anything else");
    assert.ok(statuses.includes(429), "the limit of the anonymous budget is reached");
    assert.equal(running.app.context.alarms.active().length, 0);
  });
});

test("the route answers only POST", async () => {
  await withServer(async (running) => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const answer = await send(running, { method, headers: { Authorization: `Bearer ${AI_TOKEN}` } });
      assert.ok(answer.status >= 400 && answer.status < 500, `${method}: ${answer.status}`);
    }
  });
});

test("parseActivityEvent never throws and never keeps more than the contract names", () => {
  let seed = 20260101;
  const next = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pieces: unknown[] = [null, true, false, 0, 1, -1, 1.5, 1e308, "", "x", "zone_enter", "dwell", "armor.vision.activity/v1", "cam-gate", [], {}, [1], { a: 1 }, "y".repeat(200)];
  const keys = ["schema", "type", "camera_id", "track_id", "label", "timestamp", "timestamp_ms", "authorizes_action", "zone_id", "zone_name", "seconds", "line_id", "direction", "notify", "__proto__", "extra"];
  const allowed = new Set(keys.filter(key => key !== "__proto__" && key !== "extra"));
  for (let round = 0; round < 3000; round += 1) {
    const candidate: Record<string, unknown> = {};
    for (const key of keys) if (next() < 0.5) Object.defineProperty(candidate, key, { value: pieces[Math.floor(next() * pieces.length)], enumerable: true, configurable: true, writable: true });
    const parsed = parseActivityEvent(candidate);
    if (parsed) {
      assert.ok(Object.keys(parsed).every(key => allowed.has(key)));
      assert.equal(parsed.authorizes_action, false);
      assert.ok(Number.isInteger(parsed.track_id) && parsed.track_id >= 1);
    }
  }
  for (const value of [undefined, null, 0, "", "x", [], [[]], () => 1, Symbol("s"), 10n]) assert.equal(parseActivityEvent(value), undefined);
});
