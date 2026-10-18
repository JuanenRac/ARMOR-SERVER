// The arming profiles: the parser against the shared vectors, the store (defaults, the list as a whole, the reserved ones, conflicts, a restart), the way a profile travels inside the arm
// command (only to a node that understands it, always the contract's command), how loudly the server tells people, and the routes. No alarm node exists on a board yet: the states here
// are made by the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { AlarmStore, parseAlarmCommand, parseAlarmMessage, type AlarmMessage } from "../src/alarm.js";
import { AlarmCommandError, AlarmCommands } from "../src/alarm_commands.js";
import { ArmProfileStore, ProfilesConflict, ProfilesInvalid, defaultProfiles, parseArmProfile, parseProfileList, type ArmProfile } from "../src/arm_profiles.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const skip = fs.existsSync(path.join(directory, "arm_profile.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

test("profile parsing agrees with every shared conformance vector", { skip }, () => {
  const all = (JSON.parse(fs.readFileSync(path.join(directory, "arm_profile.json"), "utf8")) as { vectors: Vector[] }).vectors;
  assert.ok(all.length >= 20);
  for (const vector of all) {
    if (vector.valid) assert.doesNotThrow(() => parseArmProfile(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseArmProfile(vector.payload), `should reject: ${vector.name}`);
  }
});

const night: ArmProfile = { id: "night", name: "Night", base: "stay", entry_delay_s: 45, siren: false, notify: "normal", zones: [{ id: "hall-motion", armed: true }, { id: "garage", armed: false }, { id: "front-door", delay: "instant" }] };
const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "armor-profiles-"));

test("a house starts with away, home and night, and the list is replaced as a whole", () => {
  const dir = temp();
  const warnings: string[] = [];
  const store = new ArmProfileStore(path.join(dir, "p.json"), () => new Date(1_800_000_000_000), message => warnings.push(message));
  assert.deepEqual(store.get().profiles.map(item => `${item.id}:${item.base}`), ["away:away", "stay:stay", "night:stay"]);
  assert.equal(store.get().revision, 0);
  assert.deepEqual(warnings, []);
  const saved = store.replace([...defaultProfiles().slice(0, 2), night], 0, "admin");
  assert.deepEqual([saved.revision, saved.updated_by, saved.profiles[2].siren, saved.profiles[2].zones?.length], [1, "admin", false, 3]);
  assert.deepEqual(store.find("night")?.zones?.[1], { id: "garage", armed: false });
  // what a restart of the server finds
  const again = new ArmProfileStore(path.join(dir, "p.json"));
  assert.deepEqual(again.get().profiles, saved.profiles);
  assert.equal(again.get().revision, 1);
  // a copy is handed out, never the list itself
  store.get().profiles[0].name = "changed";
  assert.equal(store.get().profiles[0].name, "Away");
});

test("the list is checked as a whole: away and stay stay, an id once, at most eight, and a conflict is never a silent overwrite", () => {
  const dir = temp();
  const store = new ArmProfileStore(path.join(dir, "p.json"));
  const [away, stay] = defaultProfiles();
  assert.throws(() => store.replace([stay], 0, "a"), /away cannot be removed/);
  assert.throws(() => store.replace([away], 0, "a"), /stay cannot be removed/);
  assert.throws(() => store.replace([{ ...away, base: "stay" }, stay], 0, "a"), /keeps the base away/);
  assert.throws(() => store.replace([away, stay, away], 0, "a"), /once/);
  const many = Array.from({ length: 7 }, (_, index): ArmProfile => ({ id: `p${index}`, name: `P${index}`, base: "away" }));
  assert.throws(() => store.replace([away, stay, ...many], 0, "a"), /at most 8/);
  assert.doesNotThrow(() => parseProfileList([away, stay, ...many.slice(0, 6)]));
  assert.throws(() => store.replace("nope", 0, "a"), ProfilesInvalid);
  assert.equal(store.get().revision, 0);                                                         // a refused list changes nothing
  store.replace([away, stay], 0, "first");
  assert.throws(() => store.replace([away, stay], 0, "second"), (error: unknown) => error instanceof ProfilesConflict && error.current.revision === 1);
  assert.equal(store.replace([away, stay, night], undefined, "no revision given").revision, 2);   // no revision: the caller does not care (a restore)
});

test("a profile must be the contract's: limits, types, unknown fields and the zones", () => {
  const ok = (value: unknown) => assert.doesNotThrow(() => parseArmProfile(value));
  const bad = (value: unknown, pattern: RegExp) => assert.throws(() => parseArmProfile(value), pattern);
  ok(night);
  ok({ id: "x", name: "é".repeat(32), base: "away" });                                            // 32 characters, not 32 bytes
  bad({ id: "x", name: "é".repeat(33), base: "away" }, /name/);
  bad({ id: "x", name: "   ", base: "away" }, /name/);
  bad({ ...night, id: "Night" }, /id/);
  bad({ ...night, base: "disarmed" }, /base/);
  bad({ ...night, exit_delay_s: 301 }, /exit_delay_s/);
  bad({ ...night, entry_delay_s: 1.5 }, /entry_delay_s/);
  bad({ ...night, siren: "off" }, /siren/);
  bad({ ...night, notify: "silent" }, /notify/);
  bad({ ...night, pin: "1234" }, /unknown field/);
  bad({ ...night, zones: { id: "x" } }, /zones/);
  bad({ ...night, zones: [{ id: "x", name: "y" }] }, /unknown field/);
  bad({ ...night, zones: [{ id: "x", armed: true }, { id: "x" }] }, /twice/);
  bad({ ...night, zones: [{ id: "x", armed: false, delay: "entry" }] }, /left out/);
  bad({ ...night, zones: Array.from({ length: 17 }, (_, index) => ({ id: `z${index}` })) }, /at most 16/);
  bad([], /object/);
});

// ---- the command ---------------------------------------------------------------------------------------------------------------------

const state = (extra: Partial<AlarmMessage> = {}): AlarmMessage => ({
  kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true,
  zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }, { id: "window", kind: "instant", state: "normal", bypassed: false }], open_zones: [], events: [], ...extra,
});

function bench() {
  let clock = 1_000_000;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const nodes = new AlarmStore({ now: () => clock });
  let counter = 0;
  const service = new AlarmCommands({ enabled: true, nodes, audit: log, now: () => clock, random: () => `c${String(++counter).padStart(15, "0")}`.replace(/[^0-9a-f]/g, "0"), publish: (topic, payload) => { sent.push({ topic, payload }); } });
  return { service, nodes, sent, audit };
}
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (error) { return error instanceof AlarmCommandError ? error.code : `other:${String(error)}`; } return undefined; };

test("a profile goes inside the arm command, as the contract has it, and only to a node that understands it", () => {
  const b = bench();
  b.nodes.ingest(state());
  assert.equal(code(() => b.service.request("alarm-1", "arm", "stay", false, "admin", night)), "profiles_unsupported");     // an older firmware says nothing of profiles: it would not answer at all
  assert.equal(b.sent.length, 0);
  b.nodes.ingest(state({ arm_profiles: true }));
  assert.equal(code(() => b.service.request("alarm-1", "arm", "away", false, "admin", night)), "invalid_request");            // the base is the mode
  assert.equal(code(() => b.service.request("alarm-1", "disarm", undefined, false, "admin", night)), "invalid_request");      // a profile goes on an arm only
  assert.equal(code(() => b.service.request("alarm-1", "silence", undefined, false, "admin", night)), "invalid_request");
  assert.equal(b.sent.length, 0);
  const { command_id: id } = b.service.request("alarm-1", "arm", "stay", true, "admin", night);
  const command = parseAlarmCommand(JSON.parse(b.sent[0].payload));
  assert.deepEqual([command.action, command.mode, command.force, command.profile?.id, command.profile?.siren, command.profile?.zones?.length, command.command_id], ["arm", "stay", true, "night", false, 3, id]);
  assert.ok(!b.sent[0].payload.includes("pin"));
  assert.deepEqual(b.service.status().pending.map(item => item.profile), ["night"]);
  b.service.handleResult({ kind: "alarm_result", node_id: "alarm-1", timestamp_ms: 9, command_id: id, action: "arm", accepted: true, refusal: "none", phase: "exit_delay" }, "alarm-1");
  assert.deepEqual(b.service.status().recent.map(item => [item.profile, item.accepted]), [["night", true]]);
  assert.ok(b.audit.some(event => event.outcome === "allowed" && (event.detail ?? "").includes("profile night")));
});

test("an arm without a profile is exactly the command it always was, even for a node that understands profiles", () => {
  const b = bench();
  b.nodes.ingest(state({ arm_profiles: true }));
  b.service.request("alarm-1", "arm", "away", false, "admin");
  const text = b.sent[0].payload;
  const command = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(command).sort(), ["action", "command_id", "kind", "mode", "node_id", "timestamp_ms"]);
  assert.ok(!text.includes("profile"));
  const old = bench();
  old.nodes.ingest(state());                                                                       // a node of an older firmware is armed as ever
  assert.equal(code(() => old.service.request("alarm-1", "arm", "stay", false, "admin")), undefined);
});

// ---- the state, how loudly the server tells people ----------------------------------------------------------------------------------

test("the state may name the profile, and a quieter profile makes the sounding alarm high instead of critical", async () => {
  assert.doesNotThrow(() => parseAlarmMessage({ ...state({ phase: "armed", mode: "stay", arm_profiles: true }), profile: "night" }));
  assert.throws(() => parseAlarmMessage({ ...state(), profile: "night" }), /not armed/);
  assert.throws(() => parseAlarmMessage({ ...state({ phase: "armed", mode: "stay" }), profile: "Night" }), /profile/);
  assert.throws(() => parseAlarmMessage({ ...state(), arm_profiles: "yes" }), /arm_profiles/);
  const { AlarmCentre, AlarmRules } = await import("../src/alarms.js");
  const dir = temp();
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");
  rules.profileNotify = id => (id === "night" ? "normal" : id === "away" ? "urgent" : undefined);
  const open = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.severity}`);
  const ringing = (profile?: string): AlarmMessage => state({ phase: "alarm", mode: "stay", siren: false, events: [{ ago_s: 1, kind: "alarm", zone: "window" }], ...(profile ? { profile } : {}) });
  rules.handleAlarmNode(ringing("night"), undefined);
  assert.deepEqual(open(), ["alarm_sounding:high"]);
  assert.equal(centre.active().find(alarm => alarm.code === "alarm_sounding")?.detail?.profile, "night");
  rules.handleAlarmNode(state(), undefined);
  assert.deepEqual(open(), []);
  rules.handleAlarmNode(ringing("away"), undefined);
  assert.deepEqual(open(), ["alarm_sounding:critical"]);
  rules.handleAlarmNode(state(), undefined);
  rules.handleAlarmNode(ringing("deleted-profile"), undefined);                                    // a profile the server does not know: critical, as always
  assert.deepEqual(open(), ["alarm_sounding:critical"]);
  rules.handleAlarmNode(state(), undefined);
  rules.handleAlarmNode(ringing(), undefined);
  assert.deepEqual(open(), ["alarm_sounding:critical"]);
});

// ---- the routes -----------------------------------------------------------------------------------------------------------------------

test("the profiles are read by anybody signed in and replaced by an administrator, and an arm names one by its id", async () => {
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1" });
  try {
    const cookie = await studioCookie(running.base);
    const json = { "Content-Type": "application/json", cookie };
    assert.equal((await fetch(`${running.base}/api/v1/alarm/profiles`)).status, 401);
    const listed = (await (await fetch(`${running.base}/api/v1/alarm/profiles`, { headers: { cookie } })).json()) as { revision: number; profiles: ArmProfile[]; max: number };
    assert.deepEqual([listed.revision, listed.profiles.map(item => item.id), listed.max], [0, ["away", "stay", "night"], 8]);

    const put = (body: unknown) => fetch(`${running.base}/api/v1/alarm/profiles`, { method: "PUT", headers: json, body: JSON.stringify(body) });
    assert.equal((await fetch(`${running.base}/api/v1/alarm/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const refused = await put({ profiles: [listed.profiles[0]], revision: 0 });
    assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [400, "invalid_profiles"]);
    const saved = await put({ profiles: [...listed.profiles.slice(0, 2), night], revision: 0 });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { revision: number }).revision, 1);
    const stale = await put({ profiles: listed.profiles, revision: 0 });
    assert.deepEqual([stale.status, ((await stale.json()) as { code: string; current: { revision: number } }).code], [409, "conflict"]);

    // arming with one
    const ingest = (message: unknown) => fetch(`${running.base}/api/v1/alarm/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(message) });
    const arm = (body: Record<string, unknown>) => fetch(`${running.base}/api/v1/alarm/command`, { method: "POST", headers: json, body: JSON.stringify({ node: "alarm-1", action: "arm", ...body }) });
    const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;
    assert.equal((await ingest(state({ arm_profiles: true }))).status, 202);
    assert.equal(await codeOf(await arm({ profile: "nope" })), "unknown_profile");
    assert.equal(await codeOf(await arm({ profile: "night", mode: "away" })), "invalid_request");
    assert.equal(await codeOf(await arm({ profile: 7 })), "invalid_request");
    assert.equal(await codeOf(await fetch(`${running.base}/api/v1/alarm/command`, { method: "POST", headers: json, body: JSON.stringify({ node: "alarm-1", action: "disarm", profile: "night", pin: "1" }) })), "invalid_request");
    const noBroker = await arm({ profile: "night" });                                              // the mode is the profile's base; with no broker nothing is sent
    assert.deepEqual([noBroker.status, await codeOf(noBroker)], [503, "mqtt_unavailable"]);
    assert.equal((await ingest(state())).status, 202);                                             // a node that does not say it understands profiles
    assert.equal(await codeOf(await arm({ profile: "night", mode: "stay" })), "profiles_unsupported");
    assert.equal((await ingest({ ...state({ phase: "armed", mode: "stay", arm_profiles: true }), profile: "night" })).status, 202);
    const nodes = (await (await fetch(`${running.base}/api/v1/alarm/nodes`, { headers: { cookie } })).json()) as { nodes: Array<{ state: { profile?: string } }> };
    assert.equal(nodes.nodes[0].state.profile, "night");
  } finally { await running.stop(); }
});
