import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { answerChallenge, forgetDigestMemory } from "../src/cameras/digest.js";
import { CameraVault } from "../src/cameras/vault.js";
import { cameraPublic, hideSnapshotLogin, parseCameraInput, type CameraConnection } from "../src/cameras/model.js";
import { readConfig } from "../src/config.js";
import { dayOf } from "../src/day.js";
import { DeviceCredentials } from "../src/device_credentials.js";
import { DeviceError, DeviceRegistry } from "../src/devices/registry.js";
import { Escalator } from "../src/escalation.js";
import { DiscoveryPublisher } from "../src/ha_discovery.js";
import { KnownNodes } from "../src/known_nodes.js";
import { AlertNotifier, alertMessageFor, type AlertMessage } from "../src/notify.js";
import { buildProof, custodyOf, verifyProof, type ProofFile } from "../src/evidence_proof.js";
import { auditLinesAbout } from "../src/routes/system.js";
import { UserStore } from "../src/users.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

const fileIn = (name: string) => path.join(tempDir(), name);

// ---- silent and instant alarms ---------------------------------------------------------------------------------------------------------

test("a duress alarm is silent: off every default list, never acknowledged in bulk, and only an administrator can take it", () => {
  const centre = new AlarmCentre({ file: fileIn("alarms.json") });
  const duress = centre.raiseDuress("ana")!;
  assert.equal(duress.silent, true);
  assert.ok(duress.cleared_at, "an event: it is over the moment it happens");
  assert.deepEqual(centre.active(), []);
  assert.deepEqual(centre.recent(), []);
  assert.deepEqual(centre.active({ silent: true }).map(alarm => alarm.id), [duress.id]);
  assert.equal(centre.acknowledgeAll("panel"), 0, "acknowledging everything leaves it alone");
  assert.equal(centre.acknowledge(duress.id, "panel"), undefined, "nobody else can acknowledge what they cannot see");
  assert.equal(centre.remove(duress.id), undefined);
  assert.equal(centre.clearAcknowledged(), 0);
  assert.ok(centre.acknowledge(duress.id, "ana", { silent: true }));
  assert.deepEqual(centre.recent(50, { silent: true }).map(alarm => alarm.id), [duress.id], "acknowledged and over: it goes to the record");
  assert.equal(centre.active({ silent: true }).length, 0);
});

test("an instant alarm is raised once per key and leaves the list when somebody acknowledges it", () => {
  const centre = new AlarmCentre({ file: fileIn("alarms.json") });
  const first = centre.raise("watch:1", { source: { type: "network", id: "net/aa" }, severity: "warning", code: "network_watched_online", instant: true })!;
  assert.equal(centre.raise("watch:1", { source: { type: "network", id: "net/aa" }, severity: "warning", code: "network_watched_online", instant: true }), undefined);
  assert.equal(centre.active().length, 1);
  centre.acknowledge(first.id, "ana");
  assert.equal(centre.active().length, 0, "it does not stay on the counter for ever");
  assert.ok(centre.raise("watch:2", { source: { type: "network", id: "net/aa" }, severity: "warning", code: "network_watched_online", instant: true }), "another event is another alarm");
});

test("an acknowledgement nobody vouched for does not stop a critical alarm from being escalated", () => {
  const centre = new AlarmCentre({ file: fileIn("alarms.json") });
  const alarm = centre.raise("smoke", { source: { type: "device", id: "smoke-1" }, severity: "critical", code: "smoke" })!;
  const sent: AlertMessage[] = [];
  let now = Date.parse(alarm.raised_at);
  const escalator = new Escalator({ afterMin: 5, active: () => centre.active(), send: message => sent.push(message), mode: () => "armed", now: () => now });
  centre.acknowledgeAll("panel", { verified: false });   // the wall panel's tap, or a voice command
  now += 6 * 60_000;
  assert.equal(escalator.tick(), 1, "still escalated");
  assert.equal(sent[0]?.event, "alarm.escalated");
  const other = centre.raise("gas", { source: { type: "device", id: "gas-1" }, severity: "critical", code: "gas" })!;
  centre.acknowledge(other.id, "ana");   // a person who signed in
  now += 6 * 60_000;
  assert.equal(escalator.tick(), 0, "an acknowledgement by a person ends the escalation");
  centre.acknowledge(alarm.id, "ana");
  assert.equal(centre.active().find(item => item.id === alarm.id)?.acknowledged_unverified, undefined, "a person takes over an unverified acknowledgement");
});

test("a node that speaks again brings its offline alarm down even when the store never saw it go quiet", () => {
  const centre = new AlarmCentre({ file: fileIn("alarms.json") });
  const rules = new AlarmRules(centre, () => "armed");
  rules.handleElectricalStale("el-1", true);
  rules.handleAlarmNodeStale("al-1", true, "armed");
  rules.handleNetworkStale("net-1", true);
  assert.equal(centre.active().length, 3);
  rules.handleElectrical({ node_id: "el-1", channels: [], switches: [] } as never);
  rules.handleAlarmNode({ node_id: "al-1", phase: "armed", mode: "away", siren: false, locked_out: false, zones: [], events: [] } as never, undefined);
  rules.handleNetwork({ node_id: "net-1", timestamp_ms: 1, interface: { name: "eth0" }, internet: { state: "up" } } as never);
  assert.deepEqual(centre.active().filter(alarm => !alarm.cleared_at), []);
  rules.cameraAnswered("cam-1");
  rules.raisePresentProblems({ nodesDown: [], camerasDown: ["cam-1"], devicesTriggered: [] });
  rules.cameraAnswered("cam-1");
  assert.ok(centre.active().find(alarm => alarm.code === "camera_down")?.cleared_at, "a camera that answers is not down");
});

// ---- notifier --------------------------------------------------------------------------------------------------------------------------

const audit = { record: () => undefined } as never;

test("a silent alarm goes only to the places that can carry it: not the broker, not a push, not Home Assistant", async () => {
  const published: string[] = [];
  const got: string[] = [];
  const channel = (id: "telegram" | "ntfy" | "fcm" | "homeassistant", quiet: boolean) => ({ id, ...(quiet ? { quiet: true as const } : {}), deliver: async () => { got.push(id); return { ok: true, detail: "" }; } });
  const webhooks: string[] = [];
  const notifier = new AlertNotifier({
    audit, webhookUrl: "https://hook.example/x", retryDelaysMs: [],
    fetchImpl: (async (_url: unknown, init?: RequestInit) => { webhooks.push(String(init?.body)); return new Response("", { status: 200 }); }) as typeof fetch,
    channels: [channel("telegram", true), channel("ntfy", true), channel("fcm", false), channel("homeassistant", false)],
  });
  notifier.setPublisher(topic => published.push(topic));
  const message = alertMessageFor({ type: "alarm", id: 0, at: new Date().toISOString(), alarm_id: "alm-1", state: "raised", severity: "critical", source: "duress", source_type: "alarm", code: "duress_disarm", silent: true }, "disarmed")!;
  assert.equal(message.silent, true);
  notifier.send(message);
  await notifier.idle();
  assert.deepEqual(published, [], "not on the broker, where a panel listens");
  assert.deepEqual(got.sort(), ["ntfy", "telegram"]);
  assert.equal(webhooks.length, 1);
  // an ordinary alarm goes everywhere
  got.length = 0;
  notifier.send({ ...message, silent: undefined } as AlertMessage);
  await notifier.idle();
  assert.deepEqual(got.sort(), ["fcm", "homeassistant", "ntfy", "telegram"]);
  assert.equal(published.length, 1);
});

test("a place that is down delays only itself, and an urgent message goes in front of the others", async () => {
  const order: string[] = [];
  let release!: () => void;
  const stuck = new Promise<void>(resolve => { release = resolve; });
  const notifier = new AlertNotifier({
    audit, retryDelaysMs: [],
    channels: [
      { id: "telegram", deliver: async (message: AlertMessage) => { order.push(`telegram:${message.code}`); await stuck; return { ok: true, detail: "" }; } },
      { id: "ntfy", deliver: async (message: AlertMessage) => { order.push(`ntfy:${message.code}`); return { ok: true, detail: "" }; } },
    ],
  });
  const message = (code: string, severity: "critical" | "warning"): AlertMessage => ({ service: "armor-server", event: "alarm.raised", at: new Date().toISOString(), mode: "armed", code, severity });
  notifier.send(message("first", "warning"));
  notifier.send(message("second", "warning"));
  notifier.send(message("smoke", "critical"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(order.filter(item => item.startsWith("ntfy")), ["ntfy:first", "ntfy:smoke", "ntfy:second"], "ntfy was not kept waiting by the stuck telegram, and the urgent one went before the second");
  release();
  await notifier.idle();
  assert.deepEqual(order.filter(item => item.startsWith("telegram")), ["telegram:first", "telegram:smoke", "telegram:second"]);
});

// ---- devices and cameras ---------------------------------------------------------------------------------------------------------------

test("a device cannot use the topics of the nodes, the server or Home Assistant", () => {
  const registry = new DeviceRegistry({ file: fileIn("devices.json") });
  const make = (commandTopic: string, stateTopic?: string) => registry.create({
    name: "Plug", kind: "smart_plug", commands: { mqtt: { topic: commandTopic, on: "ON" } },
    ...(stateTopic ? { source: { type: "mqtt", topic: stateTopic } as never } : {}),
  } as never);
  for (const topic of ["armor/alarm/alarm-1/command", "armor/electrical/e-1/command", "armor/server/alert", "armor/node/n-1/command", "homeassistant/switch/x/config", "ARMOR/alarm/a/zigbee"]) {
    assert.throws(() => make(topic), (error: unknown) => error instanceof DeviceError && error.code === "reserved_topic", topic);
  }
  assert.throws(() => make("zigbee2mqtt/plug/set", "armor/alarm/alarm-1/state"), (error: unknown) => error instanceof DeviceError && error.code === "reserved_topic");
  assert.ok(make("zigbee2mqtt/plug/set"));
  assert.ok(make("armor/device/plug-2/command"));
});

const camera = (extra: Partial<CameraConnection> = {}): CameraConnection => ({ id: "cam-door", name: "Door", host: "10.0.0.5", snapshotUrl: "", rtspPath: "live", onvifPort: 80, rtspPort: 554, secrets: { username: "root", password: "pw" }, ...extra });

test("the login of a camera does not live in its snapshot address: refused, and hidden when it was stored before", () => {
  const form = (snapshotUrl: string) => ({ id: "cam-door", name: "Door", host: "10.0.0.5", snapshotUrl });
  assert.equal(parseCameraInput(form("http://root:secret@10.0.0.5/snap.cgi")), null);
  assert.equal(parseCameraInput(form("http://10.0.0.5/snap.cgi?user=root&pwd=secret")), null);
  assert.ok(parseCameraInput(form("http://10.0.0.5/snap.cgi")));
  const stored = camera({ snapshotUrl: "http://root:secret@10.0.0.5/snap.cgi?pwd=hunter2" });
  const shown = cameraPublic(stored, false).snapshotUrl;
  assert.equal(shown, "http://***@10.0.0.5/snap.cgi?pwd=***");
  assert.ok(!shown.includes("secret") && !shown.includes("hunter2"));
  assert.equal(hideSnapshotLogin("http://10.0.0.5/snap.cgi"), "http://10.0.0.5/snap.cgi", "an address without a login is as it was");
  // the form gives back what it was shown: that means "keep what is stored"
  assert.equal(parseCameraInput(form(shown), stored)?.snapshotUrl, stored.snapshotUrl);
  assert.equal(parseCameraInput(form(shown))?.snapshotUrl, "", "with nothing stored the hidden address is dropped");
});

test("credentials that cannot be opened with the key in use are kept and come back with the right key", () => {
  const file = fileIn("cameras.json");
  const good = new CameraVault({ file, secret: "a".repeat(40) });
  good.save(camera());
  const wrong = new CameraVault({ file, secret: "b".repeat(40), warn: () => undefined });
  assert.equal(wrong.get("cam-door")?.secrets, undefined);
  wrong.save(camera({ id: "cam-yard", name: "Yard" }));   // a rewrite of the file
  const back = new CameraVault({ file, secret: "a".repeat(40) });
  assert.equal(back.get("cam-door")?.secrets?.password, "pw", "the first camera's login survived the rewrite");
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.startsWith("cameras.json.unreadable-")), "and a copy of the file as it was");
  // typing new credentials replaces the unreadable ones
  wrong.save(camera({ secrets: { username: "root", password: "new" } }));
  assert.equal(new CameraVault({ file, secret: "b".repeat(40) }).get("cam-door")?.secrets?.password, "new");
});

test("a device login that cannot be opened is kept too", () => {
  const file = fileIn("logins.json");
  const good = new DeviceCredentials({ file, secret: "a".repeat(40) });
  good.set("router-1", { user: "admin", password: "pw" });
  const wrong = new DeviceCredentials({ file, secret: "b".repeat(40) });
  assert.equal(wrong.get("router-1"), undefined);
  wrong.set("printer-1", { user: "u", password: "p" });   // a rewrite
  assert.equal(new DeviceCredentials({ file, secret: "a".repeat(40) }).get("router-1")?.password, "pw");
});

test("a camera that asked for Digest is never sent its password in Basic", () => {
  forgetDigestMemory();
  const credentials = { username: "root", password: "pw" };
  const basic = 'Basic realm="camera"', digest = 'Digest realm="camera", nonce="abc123", qop="auth"';
  assert.ok(answerChallenge(basic, credentials, "GET", "/x", "cam-a@10.0.0.5"), "a camera that never asked for Digest may still be Basic-only");
  assert.ok(answerChallenge(digest, credentials, "GET", "/x", "cam-b@10.0.0.6"));
  assert.equal(answerChallenge(basic, credentials, "GET", "/x", "cam-b@10.0.0.6"), null, "after Digest, Basic from the same address is a downgrade");
  assert.ok(answerChallenge(basic, credentials, "GET", "/x"), "without a name to remember, behaviour is as before");
  forgetDigestMemory();
});

// ---- nodes that are dead when the server comes up --------------------------------------------------------------------------------------

test("the known nodes survive a restart, and the ones that stay silent are reported once the grace time has passed", () => {
  const file = fileIn("known.json");
  let now = 1_000_000;
  const first = new KnownNodes({ file, now: () => now });
  first.seen("alarm", "panel-1", "armed");
  first.seen("electrical", "board-1");
  first.seen("network", "net-1");
  first.flush();
  now += 60_000;
  const second = new KnownNodes({ file, now: () => now });
  assert.equal(second.list().length, 3);
  assert.deepEqual(second.silent(30_000), [], "before the grace time nobody is called silent");
  now += 31_000;
  second.seen("electrical", "board-1");   // this one spoke after the restart
  assert.deepEqual(second.silent(30_000).map(node => `${node.kind}/${node.id}`).sort(), ["alarm/panel-1", "network/net-1"]);
  assert.equal(second.silent(30_000).find(node => node.kind === "alarm")?.phase, "armed", "what the panel was doing is remembered");
  second.forget("alarm", "panel-1");
  assert.deepEqual(second.silent(30_000).map(node => node.id), ["net-1"]);
  second.flush();
  assert.equal(new KnownNodes({ file, now: () => now }).list().some(node => node.id === "panel-1"), false, "forgotten for good");
});

test("a panel that was there before a restart and has not spoken blocks the check before arming", async () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "known-nodes.json"), JSON.stringify({ schema: 1, nodes: [{ kind: "alarm", id: "panel-9", last_seen_ms: 1, phase: "armed" }] }));
  const running = await startServer({ ARMOR_DATA_DIR: dataDir, ARMOR_NODE_STALE_AFTER_S: "5" });
  try {
    const headers = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    const early = await (await fetch(`${running.base}/api/v1/preflight`, { headers })).json() as { issues: Array<{ code: string; id: string }> };
    assert.deepEqual(early.issues.filter(issue => issue.id === "panel-9"), [], "inside the grace time it may just be reconnecting");
    await new Promise(resolve => setTimeout(resolve, 10_200));
    const late = await (await fetch(`${running.base}/api/v1/preflight`, { headers })).json() as { ready: boolean; issues: Array<{ code: string; id: string }> };
    assert.deepEqual(late.issues.filter(issue => issue.id === "panel-9").map(issue => issue.code), ["panel_silent"]);
    assert.equal(late.ready, false);
    const alarms = await (await fetch(`${running.base}/api/v1/alarms`, { headers })).json() as { active: Array<{ code: string; source: { id: string } }> };
    assert.ok(alarms.active.some(alarm => alarm.code === "alarm_offline" && alarm.source.id === "panel-9"), "and the silence is an alarm");
    // decommissioning it ends both
    assert.equal((await fetch(`${running.base}/api/v1/nodes/panel-9`, { method: "DELETE", headers })).status, 204);
    const after = await (await fetch(`${running.base}/api/v1/preflight`, { headers })).json() as { issues: Array<{ id: string }> };
    assert.deepEqual(after.issues.filter(issue => issue.id === "panel-9"), []);
    const stillOpen = await (await fetch(`${running.base}/api/v1/alarms`, { headers })).json() as { active: Array<{ code: string; cleared_at?: string }> };
    assert.ok(stillOpen.active.filter(alarm => alarm.code === "alarm_offline").every(alarm => alarm.cleared_at));
  } finally { await running.stop(); }
});

// ---- Home Assistant --------------------------------------------------------------------------------------------------------------------

test("Home Assistant is told again after the broker comes back, and is told when a node is taken away", () => {
  const sent: Array<[string, string]> = [];
  let nodes: unknown[] = [{ node_id: "board-1", reading: { channels: [{ id: "grid", domain: "ac", power_w: 100 }] }, received_at: "", stale: false }];
  const discovery = new DiscoveryPublisher({ prefix: "homeassistant", solar: () => [], electrical: () => nodes as never, alarm: () => [], publish: (topic, payload) => sent.push([topic, payload]) });
  assert.ok(discovery.round(true) > 0);
  const announced = sent.map(([topic]) => topic);
  sent.length = 0;
  assert.equal(discovery.round(false), 0, "nothing changed, nothing is said");
  nodes = [];
  assert.equal(discovery.round(false), announced.length, "every entity of the node is withdrawn");
  assert.deepEqual(sent.map(([topic]) => topic).sort(), [...announced].sort());
  assert.ok(sent.every(([, payload]) => payload === ""), "an empty retained message removes it");
  discovery.start(); discovery.start();   // twice must still be one timer
  discovery.stop();
});

// ---- configuration and routes ----------------------------------------------------------------------------------------------------------

test("two secrets with the same value are refused, and the proxy setting is read strictly", () => {
  const env = { ...SECRETS, ARMOR_DATA_DIR: tempDir() };
  assert.throws(() => readConfig({ ...env, ARMOR_CONTROL_TOKEN: env.ARMOR_INGEST_TOKEN }), /ARMOR_INGEST_TOKEN and ARMOR_CONTROL_TOKEN must be different/);
  assert.throws(() => readConfig({ ...env, ARMOR_OPERATOR_TOKEN: env.ARMOR_INGEST_TOKEN }), /must be different/);
  assert.throws(() => readConfig({ ...env, ARMOR_AI_TOKEN: env.ARMOR_CONTROL_TOKEN }), /must be different/);
  assert.equal(readConfig(env).trustProxy, false);
  assert.equal(readConfig({ ...env, ARMOR_TRUST_PROXY: "1" }).trustProxy, 1);
  assert.equal(readConfig({ ...env, ARMOR_TRUST_PROXY: "loopback, uniquelocal" }).trustProxy, "loopback, uniquelocal");
  assert.equal(readConfig({ ...env, ARMOR_TRUST_PROXY: "false" }).trustProxy, false);
  assert.throws(() => readConfig({ ...env, ARMOR_TRUST_PROXY: "$(rm -rf /)" }), /ARMOR_TRUST_PROXY/);
});

test("the control token cannot disarm while the PIN is required, unless the installation says it wants that", async () => {
  const control = { Authorization: `Bearer ${SECRETS.ARMOR_CONTROL_TOKEN}` };
  const strict = await startServer({ ARMOR_DISARM_PIN: "required" });
  try {
    const refused = await fetch(`${strict.base}/api/v1/control/disarm`, { method: "POST", headers: control });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code: string }).code, "pin_required");
    assert.equal((await fetch(`${strict.base}/api/v1/control/arm`, { method: "POST", headers: control })).status, 200, "arming never needed a PIN");
  } finally { await strict.stop(); }
  const allowed = await startServer({ ARMOR_DISARM_PIN: "required", ARMOR_CONTROL_DISARM: "1" });
  try { assert.equal((await fetch(`${allowed.base}/api/v1/control/disarm`, { method: "POST", headers: control })).status, 200); } finally { await allowed.stop(); }
  const open = await startServer();
  try { assert.equal((await fetch(`${open.base}/api/v1/control/disarm`, { method: "POST", headers: control })).status, 200, "without the requirement it works as it always did"); } finally { await open.stop(); }
});

test("someone trying passwords for one account does not lock the others out of signing in", async () => {
  const running = await startServer();
  try {
    const login = (username: string, password: string) => fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 14; attempt += 1) statuses.push((await login("victim", `wrong-${attempt}`)).status);
    assert.equal(statuses[0], 401);
    assert.equal(statuses[13], 429, "the account being hammered is limited");
    assert.equal((await login(SECRETS.ARMOR_STUDIO_USERNAME, SECRETS.ARMOR_STUDIO_PASSWORD)).status, 201, "the administrator still signs in");
  } finally { await running.stop(); }
});

test("a WebSocket client is told to listen only: a message closes it, and a big one more bluntly", async () => {
  const running = await startServer();
  try {
    const url = running.base.replace("http", "ws") + "/api/v1/events";
    const open = () => new Promise<WebSocket>((resolve, reject) => { const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_CONTROL_TOKEN}` } }); socket.once("open", () => resolve(socket)); socket.once("error", reject); });
    const closes = (socket: WebSocket) => new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    const small = await open();
    const smallClosed = closes(small);
    small.send("hello");
    assert.equal(await smallClosed, 1003);
    const big = await open();
    const bigClosed = closes(big);
    big.send("x".repeat(50_000));
    assert.equal(await bigClosed, 1009);
  } finally { await running.stop(); }
});

test("the day of the energy is the same one for solar and electrical, and the installation's own", () => {
  const moment = Date.parse("2026-06-30T23:30:00Z");
  const before = process.env.ARMOR_TZ;
  try {
    process.env.ARMOR_TZ = "UTC";
    assert.equal(dayOf(moment), "2026-06-30");
    process.env.ARMOR_TZ = "Europe/Madrid";   // 01:30 the next day there
    assert.equal(dayOf(moment), "2026-07-01");
    process.env.ARMOR_TZ = "Not/AZone";
    assert.match(dayOf(moment), /^\d{4}-\d{2}-\d{2}$/, "a wrong name falls back to the machine's own zone instead of failing");
  } finally { if (before === undefined) delete process.env.ARMOR_TZ; else process.env.ARMOR_TZ = before; }
});

// ---- wrong PINs survive a restart ------------------------------------------------------------------------------------------------------

test("wrong PINs are counted on disk: a restart is not a way round the lock, and the ladder goes up to an hour", () => {
  const file = fileIn("users.json");
  const make = () => new UserStore({ file, seed: { username: "admin", password: "correct-horse-battery" }, minPasswordLength: 8, resetSeedPassword: false });
  const first = make();
  const id = first.list()[0]!.id;
  first.setPin(id, "2468");
  const start = 10_000_000;
  assert.equal(first.verifyPin(id, "0000", start), "bad");
  assert.equal(first.verifyPin(id, "0000", start), "bad");
  assert.equal(first.verifyPin(id, "0000", start), "locked");
  const restarted = make();   // the power was cut
  assert.equal(restarted.verifyPin(id, "2468", start + 1000), "locked", "the right PIN still waits");
  assert.ok(restarted.pinLockedFor(id, start + 1000) > 50);
  assert.equal(restarted.verifyPin(id, "2468", start + 61_000), "ok", "and works when the minute is over");
  assert.equal(make().pinLockedFor(id, start + 61_000), 0, "a right PIN clears the count on disk as well");
  // the ladder: 1 min, 5, 15, then an hour every time
  let at = start;
  const waits: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    for (let miss = 0; miss < 3; miss += 1) restarted.verifyPin(id, "9999", at);
    waits.push(restarted.pinLockedFor(id, at));
    at += 24 * 3_600_000;
  }
  assert.deepEqual(waits, [60, 300, 900, 3600, 3600]);
});

// ---- the event history and a push token ------------------------------------------------------------------------------------------------

test("a viewer cannot push the phones of the others out of the list, and a user's phones go when the user does", async () => {
  const running = await startServer();
  try {
    const { fcmDevices } = running.app.context;
    for (let i = 0; i < 12; i += 1) fcmDevices.add(`viewer-token-${String(i).padStart(2, "0")}-${"z".repeat(20)}`, "viewer");
    assert.equal(fcmDevices.forUser("viewer"), 5);
    assert.equal(fcmDevices.removeUser("viewer"), 5);
  } finally { await running.stop(); }
});


// ---- the proof of custody ---------------------------------------------------------------------------------------------------------------

test("the custody reads the rotated audit files too, and says when the trail does not reach back to the file", () => {
  const dir = tempDir();
  const line = (at: string, action: string, target: string) => JSON.stringify({ at, action, outcome: "allowed", target }) + "\n";
  const target = "cam-door/recordings/a.mp4";
  fs.writeFileSync(path.join(dir, "audit.log.2"), line("2026-01-01T00:00:00.000Z", "evidence.hash", target) + line("2026-01-01T00:00:01.000Z", "evidence.hash", "cam-door/recordings/other.mp4"));
  fs.writeFileSync(path.join(dir, "audit.log.1"), line("2026-02-01T00:00:00.000Z", "evidence.protect", target));
  fs.writeFileSync(path.join(dir, "audit.log"), line("2026-03-01T00:00:00.000Z", "evidence.proof", target));
  const trail = auditLinesAbout(dir, target);
  assert.deepEqual(trail.lines.map(entry => entry.action), ["evidence.hash", "evidence.protect", "evidence.proof"], "oldest first, from every file, and only about this one");
  assert.equal(trail.from, "2026-01-01T00:00:00.000Z");
  const file: ProofFile = { camera: "cam-door", kind: "recordings", name: "a.mp4", bytes: 10, created_at: "2025-12-31T00:00:00.000Z", sha256: "a".repeat(64), protected: true };
  const covers = buildProof("secret-key", { ...file, created_at: "2026-01-01T00:00:00.000Z" }, custodyOf(trail.lines, target), new Date(), { auditFrom: trail.from });
  assert.equal(covers.custody_complete, true);
  const partial = buildProof("secret-key", file, custodyOf(trail.lines, target), new Date(), { auditFrom: trail.from });
  assert.equal(partial.custody_complete, false, "the audit starts after the file was made: the custody begins in the middle of the story and says so");
  assert.equal(verifyProof("secret-key", partial), true);
  assert.equal(verifyProof("secret-key", { ...partial, custody_complete: true }), false, "the claim is part of what is signed");
  assert.equal(buildProof("secret-key", file, []).custody_complete, undefined, "a proof made without that knowledge says nothing about it");
});

test("a proof is checked against every key the server still knows, so rotating one does not void the proofs", () => {
  const file: ProofFile = { camera: "c", kind: "photos", name: "x.jpg", bytes: 1, created_at: "2026-01-01T00:00:00.000Z", sha256: "b".repeat(64), protected: false };
  const proof = buildProof("old-control-token", file, []);
  assert.equal(verifyProof("new-evidence-key", proof), false);
  assert.equal(verifyProof(["new-evidence-key", "old-control-token"], proof), true);
  assert.equal(verifyProof([], proof), false);
});
