import assert from "node:assert/strict";
import test from "node:test";
import type { AppContext } from "../src/context.js";
import { clientMessage, mediaError, MediaError } from "../src/cameras/errors.js";
import { checkDisarm, disarmPinMode } from "../src/routes/disarm_gate.js";
import { NodeDiagnosticsStore } from "../src/node_diagnostics.js";
import type { DiagnosticPackage } from "../src/node_diag_contract.js";
import { ANSWERED_HERE, carryOut, type VoiceActionContext } from "../src/voice_actions.js";
import { VOICE_LANGUAGES } from "../src/voice.js";

// ---- cameras/errors ----

test("a media error keeps its message for the client and anything else becomes the generic one", () => {
  const known = mediaError("the camera did not answer");
  assert.ok(known instanceof MediaError);
  assert.equal(known.name, "MediaError");
  assert.equal(clientMessage(known, "generic"), "the camera did not answer");
  assert.equal(clientMessage(new Error("rtsp://user:pass@host/stream"), "generic"), "generic");
  assert.equal(clientMessage("rtsp://secret", "generic"), "generic");
  assert.equal(clientMessage(undefined, "generic"), "generic");
});

// ---- node_diagnostics ----

const pkg = (detail: "package" | "log"): DiagnosticPackage => ({ detail, log: "line", truncated: false });

test("the diagnostics store keeps one slot per kind, copies what it keeps and forgets", () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const store = new NodeDiagnosticsStore({ now: () => clock });
  assert.deepEqual(store.get("n1"), {});
  assert.deepEqual(store.when("n1"), {});
  const original = pkg("package");
  store.keep("n1", original, "admin");
  original.log = "changed afterwards";
  assert.equal(store.get("n1").package?.data.log, "line");
  assert.equal(store.get("n1").package?.requested_by, "admin");
  assert.equal(store.get("n1").package?.at, "2026-01-01T00:00:00.000Z");
  clock += 60_000;
  store.keep("n1", pkg("log"), "other");
  assert.deepEqual(store.when("n1"), { package_at: "2026-01-01T00:00:00.000Z", log_at: "2026-01-01T00:01:00.000Z" });
  // what is read is a copy
  const read = store.get("n1");
  read.package!.data.log = "tampered";
  assert.equal(store.get("n1").package?.data.log, "line");
  store.forget("n1");
  assert.deepEqual(store.get("n1"), {});
});

test("the diagnostics store refuses a new node when it is full but still updates a known one", () => {
  const store = new NodeDiagnosticsStore({ maxNodes: 2 });
  store.keep("a", pkg("package"), "x");
  store.keep("b", pkg("package"), "x");
  assert.throws(() => store.keep("c", pkg("package"), "x"), /too many nodes/);
  assert.doesNotThrow(() => store.keep("a", pkg("log"), "x"));
  store.forget("a");
  assert.doesNotThrow(() => store.keep("c", pkg("package"), "x"));
});

// ---- routes/disarm_gate ----

type Pin = "ok" | "duress" | "bad" | "locked" | "none";
function gateContext(mode: "never" | "if_set" | "always", pin: Pin, env?: "always" | "if_set") {
  const audit: Array<Record<string, unknown>> = [];
  const context = {
    config: { disarmPinEnv: env },
    securitySettings: { get: () => mode },
    audit: { record: (entry: Record<string, unknown>) => audit.push(entry) },
    users: { verifyPin: () => pin, pinLockedFor: () => 42 },
  } as unknown as AppContext;
  return { context, audit };
}

test("the disarm mode comes from the environment first and from the setting otherwise", () => {
  assert.equal(disarmPinMode(gateContext("never", "none").context), "never");
  assert.equal(disarmPinMode(gateContext("never", "none", "always").context), "always");
  assert.equal(disarmPinMode(gateContext("always", "none", "if_set").context), "if_set");
});

test("a right PIN lets the disarm through and the duress PIN does too, flagged", () => {
  assert.deepEqual(checkDisarm(gateContext("if_set", "ok").context, { id: "u" }, "1234", "a"), { allow: true, duress: false });
  assert.deepEqual(checkDisarm(gateContext("if_set", "duress").context, { id: "u" }, "9999", "a"), { allow: true, duress: true });
});

test("a user without a PIN disarms in if_set and never, and is refused in always", () => {
  assert.deepEqual(checkDisarm(gateContext("if_set", "none").context, { id: "u" }, undefined, "a"), { allow: true, duress: false });
  assert.deepEqual(checkDisarm(gateContext("never", "none").context, { id: "u" }, undefined, "a"), { allow: true, duress: false });
  const { context, audit } = gateContext("always", "none");
  const verdict = checkDisarm(context, { id: "u" }, undefined, "alice");
  assert.equal(verdict.allow, false);
  if (!verdict.allow) { assert.equal(verdict.status, 403); assert.equal(verdict.body.code, "pin_not_set"); }
  assert.deepEqual(audit.map(entry => [entry.action, entry.outcome, entry.detail]), [["control.disarm", "denied", "no pin set"]]);
});

test("a wrong PIN is refused with 403 and a locked user with 429 and the seconds left", () => {
  const wrong = gateContext("if_set", "bad");
  const verdict = checkDisarm(wrong.context, { id: "u" }, "0000", "alice", "silence");
  assert.equal(verdict.allow, false);
  if (!verdict.allow) { assert.equal(verdict.status, 403); assert.equal(verdict.body.code, "wrong_pin"); }
  assert.equal(wrong.audit[0].action, "control.silence");
  const locked = gateContext("if_set", "locked");
  const lockedVerdict = checkDisarm(locked.context, { id: "u" }, "0000", "alice");
  assert.equal(lockedVerdict.allow, false);
  if (!lockedVerdict.allow) { assert.equal(lockedVerdict.status, 429); assert.equal(lockedVerdict.body.code, "pin_locked"); assert.equal(lockedVerdict.body.retry_after_s, 42); }
});

test("with the mode never a wrong PIN stops nothing", () => {
  assert.deepEqual(checkDisarm(gateContext("never", "bad").context, { id: "u" }, "0000", "a"), { allow: true, duress: false });
  assert.deepEqual(checkDisarm(gateContext("never", "locked").context, { id: "u" }, "0000", "a"), { allow: true, duress: false });
});

test("without a user nothing is checked and the mode always refuses", () => {
  assert.deepEqual(checkDisarm(gateContext("if_set", "bad").context, undefined, "0000", "a"), { allow: true, duress: false });
  assert.equal(checkDisarm(gateContext("always", "ok").context, undefined, "0000", "a").allow, false);
});

// ---- voice_actions ----

type Light = { id: string; name: string; kind: string; risk: string };
function voiceContext(overrides: Record<string, unknown> = {}, lights: Light[] = [], failing: string[] = []) {
  const sent: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const base = {
    alarms: { active: () => [] as Array<{ severity: string }> },
    store: { snapshot: () => ({ nodes: {} as Record<string, { online: boolean; target_count: number }> }) },
    vault: { list: () => [] as Array<{ id: string; name: string }> },
    cameraWatcher: { snapshot: () => [] as Array<{ id: string; status: string }> },
    solar: { totals: () => ({ inverters: 0, batteries: 0, pv_w: 0, load_w: 0, soc_percent: null as number | null }) },
    electricalNodes: { totals: () => ({ grid_w: null as number | null }) },
    networkNodes: { totals: () => ({ internet: null as string | null, online: 0 }) },
    devices: { list: () => lights },
    sendDeviceCommand: async (id: string, command: string) => { if (failing.includes(id)) throw new Error("unreachable"); sent.push(`${id}=${command}`); },
    audit: { record: (entry: Record<string, unknown>) => audit.push(entry) },
  };
  return { context: { ...base, ...overrides } as unknown as VoiceActionContext, sent, audit };
}

test("the commands answered here are the closed list and an unknown one is left to the caller", async () => {
  assert.deepEqual([...ANSWERED_HERE].sort(), ["alarms", "cameras", "electrical", "help", "lights_off", "lights_on", "network", "nodes", "radar", "solar", "time"]);
  assert.equal(await carryOut("arm", "en", voiceContext().context, "a"), undefined);
});

test("every command answers in the eight languages without leaving a placeholder", async () => {
  const { context } = voiceContext();
  for (const language of VOICE_LANGUAGES) {
    for (const intent of ANSWERED_HERE) {
      const answer = await carryOut(intent, language, context, "a", new Date("2026-01-01T10:30:00Z"));
      assert.ok(answer && answer.speech.length > 0, `${language}/${intent}`);
      assert.ok(!/\{\d+\}/.test(answer.speech), `${language}/${intent} has a placeholder left`);
    }
  }
});

test("the alarms are counted and the serious ones are the critical and high", async () => {
  const none = await carryOut("alarms", "en", voiceContext().context, "a");
  assert.deepEqual(none?.result, { active: 0, serious: 0 });
  const { context } = voiceContext({ alarms: { active: () => [{ severity: "critical" }, { severity: "high" }, { severity: "low" }] } });
  const answer = await carryOut("alarms", "en", context, "a");
  assert.equal(answer?.speech, "3 active alarm(s), 2 of them serious.");
  assert.deepEqual(answer?.result, { active: 3, serious: 2 });
});

test("the nodes say how many are online and name at most three that are not", async () => {
  const nodes = Object.fromEntries(["a", "b", "c", "d", "e"].map(id => [id, { online: false, target_count: 0 }]));
  nodes.z = { online: true, target_count: 2 };
  const { context } = voiceContext({ store: { snapshot: () => ({ nodes }) } });
  const answer = await carryOut("nodes", "en", context, "a");
  assert.equal(answer?.speech, "1 of 6 node(s) online. Without connection: a, b, c +2.");
  assert.deepEqual(answer?.result, { online: 1, nodes: 6, offline: ["a", "b", "c", "d", "e"] });
  assert.equal((await carryOut("nodes", "en", voiceContext().context, "a"))?.speech, "No node has reported yet.");
});

test("the cameras that are not online count as not answering", async () => {
  const { context } = voiceContext({
    vault: { list: () => [{ id: "1", name: "Door" }, { id: "2", name: "Yard" }] },
    cameraWatcher: { snapshot: () => [{ id: "1", status: "online" }, { id: "2", status: "offline" }] },
  });
  const answer = await carryOut("cameras", "en", context, "a");
  assert.equal(answer?.speech, "1 of 2 camera(s) answering. Not answering: Yard.");
  assert.deepEqual(answer?.result, { answering: 1, cameras: 2, silent: ["Yard"] });
  assert.equal((await carryOut("cameras", "en", voiceContext().context, "a"))?.speech, "There are no cameras set up.");
});

test("the radars add the people of the online nodes only", async () => {
  const nodes = { a: { online: true, target_count: 2 }, b: { online: true, target_count: 1 }, c: { online: false, target_count: 5 } };
  const some = await carryOut("radar", "en", voiceContext({ store: { snapshot: () => ({ nodes }) } }).context, "a");
  assert.deepEqual(some?.result, { people: 3, nodes: 2 });
  const empty = await carryOut("radar", "en", voiceContext({ store: { snapshot: () => ({ nodes: { a: { online: true, target_count: 0 } } }) } }).context, "a");
  assert.equal(empty?.speech, "The radars see no one.");
  const offline = await carryOut("radar", "en", voiceContext({ store: { snapshot: () => ({ nodes: { c: nodes.c } }) } }).context, "a");
  assert.equal(offline?.speech, "No radar node is online.");
});

test("solar, electrical and network read the totals and round the watts", async () => {
  const solar = voiceContext({ solar: { totals: () => ({ inverters: 1, batteries: 1, pv_w: 1234.6, load_w: 400.2, soc_percent: 87.5 }) } });
  assert.equal((await carryOut("solar", "en", solar.context, "a"))?.speech, "Solar: 1235 W from the panels, 400 W used by the house. Battery at 88%.");
  const noBattery = voiceContext({ solar: { totals: () => ({ inverters: 1, batteries: 0, pv_w: 10, load_w: 5, soc_percent: null }) } });
  assert.equal((await carryOut("solar", "en", noBattery.context, "a"))?.speech, "Solar: 10 W from the panels, 5 W used by the house.");
  assert.equal((await carryOut("solar", "en", voiceContext().context, "a"))?.speech, "No solar equipment reports.");
  const draw = voiceContext({ electricalNodes: { totals: () => ({ grid_w: 250.4 }) } });
  assert.equal((await carryOut("electrical", "en", draw.context, "a"))?.speech, "The house draws 250 W from the grid.");
  const feed = voiceContext({ electricalNodes: { totals: () => ({ grid_w: -300 }) } });
  assert.equal((await carryOut("electrical", "en", feed.context, "a"))?.speech, "The house is giving 300 W to the grid.");
  assert.equal((await carryOut("electrical", "en", voiceContext().context, "a"))?.speech, "No electrical node reports.");
  const net = voiceContext({ networkNodes: { totals: () => ({ internet: "degraded", online: 7 }) } });
  assert.equal((await carryOut("network", "en", net.context, "a"))?.speech, "Internet is slow. 7 device(s) on the network.");
  const unknown = voiceContext({ networkNodes: { totals: () => ({ internet: "weird", online: 1 }) } });
  assert.equal((await carryOut("network", "en", unknown.context, "a"))?.speech, "Internet is unknown. 1 device(s) on the network.");
  assert.equal((await carryOut("network", "en", voiceContext().context, "a"))?.speech, "The network node does not report.");
});

test("the lights: only low risk smart lights are switched, failures are named and audited", async () => {
  const lights: Light[] = [
    { id: "l1", name: "Hall", kind: "smart_light", risk: "low" },
    { id: "l2", name: "Porch", kind: "smart_light", risk: "low" },
    { id: "incubator", name: "Incubator", kind: "smart_light", risk: "high" },
    { id: "fan", name: "Fan", kind: "smart_plug", risk: "low" },
  ];
  const { context, sent, audit } = voiceContext({}, lights, ["l2"]);
  const answer = await carryOut("lights_on", "en", context, "alice");
  assert.deepEqual(sent, ["l1=on"]);
  assert.equal(answer?.speech, "1 light(s) turned on. Porch could not be reached.");
  assert.deepEqual(answer?.result, { lights: 2, done: 1, failed: ["Porch"] });
  assert.deepEqual(audit.map(entry => [entry.outcome, entry.target, entry.actor, entry.detail]), [["allowed", "l1=on", "alice", "voice"], ["failed", "l2=on", "alice", "voice"]]);
  const off = voiceContext({}, [lights[0]]);
  assert.equal((await carryOut("lights_off", "en", off.context, "a"))?.speech, "1 light(s) turned off.");
  assert.deepEqual(off.sent, ["l1=off"]);
  const none = voiceContext({}, [lights[2]]);
  assert.equal((await carryOut("lights_on", "en", none.context, "a"))?.speech, "There are no lights set up.");
  assert.deepEqual(none.sent, []);
});

test("the time and the help come without touching the state", async () => {
  const answer = await carryOut("time", "en", voiceContext().context, "a", new Date("2026-01-01T10:30:00Z"));
  assert.match(answer!.speech, /^It is .+\.$/);
  assert.equal(typeof answer!.result.time, "string");
  assert.match((await carryOut("help", "pt", voiceContext().context, "a"))!.speech, /^Posso armar/);
});
