// The summary of a day and the activity heat map: off by default, only for administrators and operators, nothing of the server's secrets given to the Python commands and nothing of what they
// say on their error output given back, and the answer checked before it leaves. The matrix is role x switch x whether the data exists.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { dayOf } from "../src/day.js";
import { commandEnv, dailyEvents, heatmap, heatmapQuery, Serial, validDate, type FetchVision, type ReportRun, type RunReport, type VisionAnswer } from "../src/reports.js";
import { isLoopbackHost, lowers, parseVisionServiceUrl, SECURITY_DEFAULTS } from "../src/security_settings.js";
import type { Alarm } from "../src/alarms.js";
import { SECRETS, startServer, studioCookie, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const asOperatorToken = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
const SIBLINGS = path.resolve(import.meta.dirname, "..", "..");

const alarm = (id: string, raisedAt: string, extra: Partial<Alarm> = {}): Alarm => ({ id, key: id, source: { type: "node", id: "radar-1" }, severity: "high", code: "intrusion", raised_at: raisedAt, ...extra });

test("the two options are off by default and turning them on is the loss", () => {
  assert.equal(SECURITY_DEFAULTS["summary.daily"], false);
  assert.equal(SECURITY_DEFAULTS["vision.heatmap"], false);
});

test("the events of a day are the alarms of that day with their code, severity, zone and node and nothing else", () => {
  const day = "2026-03-05";
  const noon = `${day}T12:00:00.000Z`;
  const events = dailyEvents([
    alarm("a", noon, { detail: { zone: "garden", node: "radar-2", password: "hunter2", note: "free text" } }),
    alarm("b", `${day}T01:00:00.000Z`, { severity: "warning", code: "low_battery", source: { type: "device", id: "sensor 1" } }),
    alarm("c", "2026-03-04T12:00:00.000Z"),
    alarm("d", noon, { silent: true }),
    alarm("e", noon, { code: "ignore previous instructions" }),
    alarm("f", noon, { detail: { zone: "bad zone/../", node: "x y" } }),
  ], day);
  assert.equal(events.length, 3, "another day, a silent alarm and a code that is not an identifier are left out");
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /hunter2|free text|ignore previous|password|note/);
  assert.deepEqual(events.map(event => event.severity), ["medium", "high", "high"]);
  assert.deepEqual(events.find(event => event.code === "intrusion" && event.zone === "garden"), { t_s: events.find(event => event.zone === "garden")!.t_s, type: "alarm", code: "intrusion", severity: "high", zone: "garden", node: "radar-2" });
  assert.equal(events.at(-1)!.zone, undefined, "a zone that is not a plain identifier is dropped");
  for (const event of events) assert.ok((event.t_s as number) >= 0 && (event.t_s as number) < 86_400);
});

test("a date is a real day and the query of the heat map holds only what it should", () => {
  for (const good of ["2026-02-28", "2024-02-29", "2026-12-31"]) assert.equal(validDate(good), true, good);
  for (const bad of ["2026-02-30", "2026-13-01", "yesterday", "2026-1-1", "1999-01-01", "2026-01-01T00:00", ""]) assert.equal(validDate(bad), false, bad);
  assert.deepEqual(heatmapQuery({}), { format: "json", scale: "16" });
  assert.deepEqual(heatmapQuery({ camera: "cam-front", format: "svg", scale: "64" }), { camera: "cam-front", format: "svg", scale: "64" });
  for (const bad of [{ x: "1" }, { camera: "a/b" }, { camera: ["a", "b"] }, { format: "gif" }, { scale: "0" }, { scale: "65" }, { scale: "1e1" }, { scale: ["1"] }, { camera: "x".repeat(81) }]) assert.equal(heatmapQuery(bad), null, JSON.stringify(bad));
});

test("a command is given an environment without any secret of the server", () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ARMOR_CONTROL_TOKEN: "c".repeat(32), ARMOR_STUDIO_PASSWORD: "p".repeat(20), ARMOR_CAMERA_CONFIG_KEY: "k".repeat(40), PATH: saved.PATH ?? "" });
  try {
    const env = commandEnv("/opt/x/src");
    assert.equal(env.PYTHONPATH, "/opt/x/src");
    assert.deepEqual(Object.keys(env).filter(name => name.startsWith("ARMOR")), []);
    assert.doesNotMatch(JSON.stringify(env), /cccccc|pppppp|kkkkkk/);
  } finally { Object.assign(process.env, saved); delete process.env.ARMOR_CONTROL_TOKEN; delete process.env.ARMOR_STUDIO_PASSWORD; delete process.env.ARMOR_CAMERA_CONFIG_KEY; }
});

test("reports run one at a time and a burst is turned away", async () => {
  const serial = new Serial(2);
  const order: string[] = [];
  const slow = (name: string) => () => new Promise<string>(resolve => { order.push(`start ${name}`); setTimeout(() => { order.push(`end ${name}`); resolve(name); }, 20); });
  const results = await Promise.all([serial.run(slow("a")), serial.run(slow("b")), serial.run(slow("c"))]);
  assert.deepEqual(results, ["a", "b", "busy"]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

// ------------------------------------------------------------------ the routes

/** Folders that look like the two projects (enough for the server to see them) and settings files; the command itself is a stand-in. */
function projects() {
  const root = tempDir();
  const ai = path.join(root, "ARMOR-SERVER-AI");
  fs.mkdirSync(path.join(ai, "src", "armor_server_ai"), { recursive: true });
  fs.writeFileSync(path.join(ai, "src", "armor_server_ai", "cli.py"), "");
  const files = { summaryConfig: path.join(root, "summary.json") };
  for (const file of Object.values(files)) fs.writeFileSync(file, "{}");
  const env = { ARMOR_DAILY_SUMMARY_AI_DIR: ai, ARMOR_DAILY_SUMMARY_CONFIG: files.summaryConfig, ARMOR_VISION_SERVICE_URL: "http://127.0.0.1:8765" };
  return { root, env, files };
}

const REPORT = { summary: { schema: "armor-daily-summary/1", totals: { events: 0, alarms: 0, serious_alarms: 0, false_alarms: 0 }, by_type: {}, by_zone: {}, by_hour: new Array(24).fill(0) }, findings: [], text: "Daily summary" };
const MAP = { schema: "armor.vision.heatmap/v1", camera_id: "cam-front", cols: 2, rows: 1, accepted_positions: 1, rejected_positions: 0, total: 1, max: 1, weights: [[1, 0]], normalized: [[1, 0]], contains_images: false };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const envelope = (status: number, type: string, body: Buffer | string) => Buffer.from(JSON.stringify({ status, content_type: type, body_base64: Buffer.from(body).toString("base64") }));

type Calls = ReportRun[];
/** A stand-in for the Python commands: it answers what the test says and remembers what it was asked. */
function runner(answer: (run: ReportRun) => { code: number; stdout?: Buffer | string; stderr?: string }): { run: RunReport; calls: Calls } {
  const calls: Calls = [];
  return { calls, run: async run => { calls.push(run); const result = answer(run); return { code: result.code, stdout: Buffer.from(result.stdout ?? ""), stderr: result.stderr ?? "" }; } };
}
type VisionCalls = string[];
/** A stand-in for the live service of ARMOR-VISION: it answers what the test says and remembers the addresses it was asked for. */
function vision(answer: (url: string) => VisionAnswer = () => ({ status: 200, type: "application/json", body: Buffer.from(JSON.stringify(MAP)) })): { fetch: FetchVision; calls: VisionCalls } {
  const calls: VisionCalls = [];
  return { calls, fetch: async url => { calls.push(url); return answer(url); } };
}
const good = runner(run => run.args.includes("heatmap-route") ? { code: 0, stdout: envelope(200, "application/json", JSON.stringify(MAP)) } : { code: 0, stdout: JSON.stringify(REPORT) });

async function accounts(running: Running, admin: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { admin };
  for (const role of ["operator", "viewer", "panel"]) {
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-123`, role }) });
    assert.equal(made.status, 201, role);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-123` }) });
    out[role] = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
  }
  return out;
}
const turn = (running: Running, admin: string, settings: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(settings) });
const ask = (running: Running, route: string, headers: Record<string, string> = {}) => fetch(`${running.base}${route}`, { headers });

const ROUTES = { summary: "/api/v1/summary/daily", heatmap: "/api/v1/vision/heatmap" } as const;
const SWITCH = { summary: "summary.daily", heatmap: "vision.heatmap" } as const;

test("with the switches off both routes answer 404 to administrators and operators, nothing is run and the others are refused", async () => {
  const stand = runner(() => ({ code: 0, stdout: "{}" }));
  const running = await startServer(projects().env, { runReport: stand.run });
  try {
    const admin = await studioCookie(running.base);
    const who = await accounts(running, admin);
    for (const route of Object.values(ROUTES)) {
      assert.equal((await ask(running, route, { cookie: who.admin })).status, 404, `${route} admin`);
      assert.equal((await ask(running, route, { cookie: who.operator })).status, 404, `${route} operator`);
      assert.equal((await ask(running, route, asOperatorToken)).status, 404, `${route} operator token`);
      assert.equal((await ask(running, route, { cookie: who.viewer })).status, 403, `${route} viewer`);
      assert.equal((await ask(running, route, { cookie: who.panel })).status, 403, `${route} panel`);
      assert.equal((await ask(running, route)).status, 401, `${route} nobody`);
      assert.equal((await ask(running, route, { Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` })).status, 401, `${route} node token`);
    }
    assert.equal(stand.calls.length, 0, "no command was started");
    const state = (await (await ask(running, "/api/v1/security/settings", { cookie: admin })).json()) as { settings: Record<string, unknown>; defaults: Record<string, unknown> };
    assert.equal(state.settings["summary.daily"], false);
    assert.equal(state.settings["vision.heatmap"], false);
  } finally { await running.stop(); }
});

test("only an administrator can turn either option on, and it is written in the audit trail as a loss", async () => {
  const running = await startServer(projects().env, { runReport: good.run });
  try {
    const admin = await studioCookie(running.base);
    const who = await accounts(running, admin);
    for (const role of ["operator", "viewer", "panel"]) assert.ok((await turn(running, who[role], { "summary.daily": true })).status >= 401, role);
    const done = await turn(running, admin, { "summary.daily": true, "vision.heatmap": true });
    assert.equal(done.status, 200);
    assert.equal((await turn(running, admin, { "summary.daily": "yes" as unknown as boolean })).status, 400);
  } finally { await running.stop(); }
});

for (const kind of ["summary", "heatmap"] as const) {
  test(`${kind}: with the switch on, administrators and operators are answered and everybody else is still refused`, async () => {
    const stand = runner(() => ({ code: 0, stdout: JSON.stringify(REPORT) }));
    const service = vision();
    const running = await startServer(projects().env, { runReport: stand.run, fetchVision: service.fetch });
    try {
      const admin = await studioCookie(running.base);
      const who = await accounts(running, admin);
      assert.equal((await turn(running, admin, { [SWITCH[kind]]: true })).status, 200);
      const route = ROUTES[kind];
      for (const [name, headers] of [["admin", { cookie: who.admin }], ["operator", { cookie: who.operator }], ["operator token", asOperatorToken]] as const) {
        const answer = await ask(running, route, headers);
        assert.equal(answer.status, 200, name);
        assert.equal(answer.headers.get("cache-control"), "private, no-store");
        assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
      }
      const calls = stand.calls.length + service.calls.length;
      for (const [name, headers, status] of [["viewer", { cookie: who.viewer }, 403], ["panel", { cookie: who.panel }, 403], ["nobody", {}, 401]] as const) assert.equal((await ask(running, route, headers)).status, status, name);
      assert.equal(stand.calls.length + service.calls.length, calls, "a refused account never starts a command or asks the service");
      // the other switch is still off
      const other = kind === "summary" ? ROUTES.heatmap : ROUTES.summary;
      assert.equal((await ask(running, other, { cookie: admin })).status, 404);
    } finally { await running.stop(); }
  });
}

test("the summary: the day and the language are checked, the command gets the events and no secret, and the answer is the report of that day", async () => {
  const day = "2026-03-05";
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "alarms.json"), JSON.stringify({ schema: 1, counter: 3, alarms: [
    { id: "1", key: "k1", source: { type: "node", id: "radar-1" }, severity: "high", code: "intrusion", raised_at: `${day}T10:00:00.000Z`, detail: { zone: "garden", password: "hunter2" } },
    { id: "2", key: "k2", source: { type: "node", id: "radar-1" }, severity: "high", code: "intrusion", raised_at: "2026-03-04T10:00:00.000Z" },
  ] }));
  let seen = "";
  const stand = runner(run => { seen = fs.readFileSync(run.args[run.args.indexOf("--daily-summary") + 1], "utf8"); return { code: 0, stdout: JSON.stringify({ ...REPORT, ai_note: "Fine." }), stderr: "/home/secret/path" }; });
  const running = await startServer({ ...projects().env, ARMOR_DATA_DIR: dir, ARMOR_PYTHON: "py-test" }, { runReport: stand.run });
  try {
    const admin = await studioCookie(running.base);
    await turn(running, admin, { "summary.daily": true });
    const answer = await ask(running, `${ROUTES.summary}?date=${day}&lang=pt`, { cookie: admin });
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["ai_note", "date", "findings", "language", "summary", "text"]);
    assert.equal(body.date, day);
    assert.equal(body.language, "pt");
    const run = stand.calls[0];
    assert.equal(run.program, "py-test");
    assert.deepEqual(run.args.slice(0, 2), ["-m", "armor_server_ai.cli"]);
    assert.ok(run.args.includes("--json") && run.args.at(-1) === "pt");
    assert.deepEqual(Object.keys(run.env).filter(name => name.startsWith("ARMOR")), []);
    assert.equal(seen.trim().split("\n").length, 1, "only the alarm of that day was handed over");
    assert.doesNotMatch(seen, /hunter2|password/);
    assert.equal(fs.existsSync(path.dirname(run.args[run.args.indexOf("--daily-summary") + 1])), false, "the temporary folder is removed");
    assert.doesNotMatch(JSON.stringify(body), /hunter2|secret\/path/);
    // the default language is the one of the alerts; a day that has nothing is still a summary
    const empty = await ask(running, `${ROUTES.summary}?date=2026-01-01`, { cookie: admin });
    assert.equal(empty.status, 200);
    assert.equal(((await empty.json()) as { language: string }).language, running.config.alertLanguage);
    for (const query of ["date=2026-02-30", "date=today", "date=2026-03-05&lang=xx", "lang=de&lang=fr"]) assert.equal((await ask(running, `${ROUTES.summary}?${query}`, { cookie: admin })).status, 422, query);
    assert.equal(dayOf(Date.now()).length, 10);
    assert.equal((await ask(running, ROUTES.summary, { cookie: admin })).status, 200, "today is the default");
  } finally { await running.stop(); }
});

test("the summary: what is not set up, what fails and what is not a report are never passed on", async () => {
  const cases: Array<{ name: string; env?: Record<string, string>; answer?: Parameters<typeof runner>[0]; status: number; error: string }> = [
    { name: "nothing set up", env: { ARMOR_DAILY_SUMMARY_AI_DIR: "", ARMOR_DAILY_SUMMARY_CONFIG: "" }, status: 503, error: "daily_summary_not_configured" },
    { name: "the settings file does not exist", env: { ARMOR_DAILY_SUMMARY_CONFIG: path.join(tempDir(), "missing.json") }, status: 503, error: "daily_summary_not_configured" },
    { name: "the folder is not the project", env: { ARMOR_DAILY_SUMMARY_AI_DIR: tempDir() }, status: 503, error: "daily_summary_not_configured" },
    { name: "off in its own settings", answer: () => ({ code: 2, stderr: "armor-vision-policy: daily summary: the daily summary is off: set \"enabled\"" }), status: 503, error: "daily_summary_off_in_settings" },
    { name: "the command fails", answer: () => ({ code: 2, stderr: "armor-vision-policy: daily summary: /home/ana/secret.jsonl: line 3" }), status: 502, error: "daily_summary_failed" },
    { name: "the command could not start", answer: () => ({ code: -1 }), status: 502, error: "daily_summary_failed" },
    { name: "it prints nothing", answer: () => ({ code: 0, stdout: "" }), status: 502, error: "daily_summary_failed" },
    { name: "it prints something else", answer: () => ({ code: 0, stdout: "[1,2]" }), status: 502, error: "daily_summary_failed" },
    { name: "a key that is not part of a report", answer: () => ({ code: 0, stdout: JSON.stringify({ ...REPORT, config: "/etc/armor/summary.json" }) }), status: 502, error: "daily_summary_failed" },
    { name: "a report without its text", answer: () => ({ code: 0, stdout: JSON.stringify({ summary: REPORT.summary, findings: [] }) }), status: 502, error: "daily_summary_failed" },
  ];
  for (const item of cases) {
    const stand = runner(item.answer ?? (() => ({ code: 0, stdout: JSON.stringify(REPORT) })));
    const running = await startServer({ ...projects().env, ...(item.env ?? {}) }, { runReport: stand.run });
    try {
      const admin = await studioCookie(running.base);
      await turn(running, admin, { "summary.daily": true });
      const answer = await ask(running, `${ROUTES.summary}?date=2026-03-05`, { cookie: admin });
      assert.equal(answer.status, item.status, item.name);
      const text = await answer.text();
      assert.deepEqual(JSON.parse(text), { error: item.error }, item.name);
      assert.doesNotMatch(text, /\/home|secret|armor-vision-policy/, item.name);
    } finally { await running.stop(); }
  }
});

test("the heat map: the query is checked, the service is asked a fixed address, and each format comes back as what it is", async () => {
  const service = vision(url => {
    const format = new URL(url).searchParams.get("format");
    if (format === "png") return { status: 200, type: "image/png", body: PNG };
    if (format === "svg") return { status: 200, type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') };
    return { status: 200, type: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(MAP)) };
  });
  const running = await startServer(projects().env, { fetchVision: service.fetch });
  try {
    const admin = await studioCookie(running.base);
    await turn(running, admin, { "vision.heatmap": true });
    const map = await ask(running, `${ROUTES.heatmap}?camera=cam-front`, { cookie: admin });
    assert.equal(map.status, 200);
    assert.deepEqual(await map.json(), MAP);
    assert.equal(service.calls[0], "http://127.0.0.1:8765/heatmap?camera=cam-front&format=json&scale=16");
    const png = await ask(running, `${ROUTES.heatmap}?format=png&scale=4`, { cookie: admin });
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await png.arrayBuffer()).equals(PNG));
    assert.equal(service.calls[1], "http://127.0.0.1:8765/heatmap?format=png&scale=4");
    const svg = await ask(running, `${ROUTES.heatmap}?format=svg`, { cookie: admin });
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const calls = service.calls.length;
    for (const query of ["format=gif", "scale=0", "scale=65", "extra=1", "camera=a/b", "camera=a&camera=b"]) assert.equal((await ask(running, `${ROUTES.heatmap}?${query}`, { cookie: admin })).status, 400, query);
    assert.equal(service.calls.length, calls, "a bad query never reaches the service");
  } finally { await running.stop(); }
});

test("the heat map: what is not set up, not this machine, unreachable, or not a map is never passed on", async () => {
  const MAPOK = (extra: object) => ({ status: 200, type: "application/json", body: Buffer.from(JSON.stringify({ ...MAP, ...extra })) });
  const cases: Array<{ name: string; env?: Record<string, string>; settings?: Record<string, unknown>; answer?: (url: string) => VisionAnswer; status: number; error: string; asked?: boolean; query?: string }> = [
    { name: "nothing set up", env: { ARMOR_VISION_SERVICE_URL: "" }, status: 503, error: "heatmap_not_configured", asked: false },
    { name: "an address on another machine while the remote switch is off", env: { ARMOR_VISION_SERVICE_URL: "http://192.168.0.50:8765" }, status: 503, error: "heatmap_not_configured", asked: false },
    { name: "the name of a machine that is not this one", env: { ARMOR_VISION_SERVICE_URL: "http://vision.example.org" }, status: 503, error: "heatmap_not_configured", asked: false },
    { name: "the service cannot be reached", answer: () => null, status: 502, error: "heatmap_failed" },
    { name: "the camera is unknown", answer: () => ({ status: 404, type: "text/plain", body: Buffer.from("unknown camera\n") }), status: 404, error: "unknown_camera" },
    { name: "the pipeline is off in its own settings", answer: () => ({ status: 404, type: "text/plain", body: Buffer.from("not found\n") }), status: 404, error: "heatmap_pipeline_off" },
    { name: "the service calls the query bad", answer: () => ({ status: 400, type: "text/plain", body: Buffer.from("scale must be a whole number\n") }), status: 400, error: "invalid_query" },
    { name: "the service fails", answer: () => ({ status: 500, type: "text/plain", body: Buffer.from("Traceback /home/ana/x.py") }), status: 502, error: "heatmap_failed" },
    { name: "a redirect is not followed", answer: () => ({ status: 302, type: "text/html", body: Buffer.from("") }), status: 502, error: "heatmap_failed" },
    { name: "a map that says it holds pictures", answer: () => MAPOK({ contains_images: true }), status: 502, error: "heatmap_failed" },
    { name: "a map of another schema", answer: () => MAPOK({ schema: "other" }), status: 502, error: "heatmap_failed" },
    { name: "a map that is not JSON", answer: () => ({ status: 200, type: "application/json", body: Buffer.from("<html>") }), status: 502, error: "heatmap_failed" },
    { name: "a map with the wrong type", answer: () => ({ status: 200, type: "text/html", body: Buffer.from(JSON.stringify(MAP)) }), status: 502, error: "heatmap_failed" },
    { name: "a picture that is not a PNG", answer: () => ({ status: 200, type: "image/png", body: Buffer.from("GIF89a") }), status: 502, error: "heatmap_failed", query: "?format=png" },
    { name: "a picture that is not an SVG", answer: () => ({ status: 200, type: "image/svg+xml", body: Buffer.from("<html></html>") }), status: 502, error: "heatmap_failed", query: "?format=svg" },
  ];
  for (const item of cases) {
    const service = vision(item.answer);
    const running = await startServer({ ...projects().env, ...(item.env ?? {}) }, { fetchVision: service.fetch });
    try {
      const admin = await studioCookie(running.base);
      await turn(running, admin, { "vision.heatmap": true });
      const answer = await ask(running, `${ROUTES.heatmap}${item.query ?? ""}`, { cookie: admin });
      assert.equal(answer.status, item.status, item.name);
      const text = await answer.text();
      assert.deepEqual(JSON.parse(text), { error: item.error }, item.name);
      assert.doesNotMatch(text, /\/home|ana/, item.name);
      if (item.asked === false) assert.deepEqual(service.calls, [], `${item.name}: the request never left`);
    } finally { await running.stop(); }
  }
});

test("the address of the live service is a setting: validated, local unless the remote switch is on, and pointing elsewhere is written as a loss", async () => {
  for (const good of ["http://127.0.0.1:8765", "http://localhost:9000", "https://127.0.0.1", "http://[::1]:8765", "http://vision.local:8765"]) assert.ok(parseVisionServiceUrl(good), good);
  for (const bad of ["", " ", "ftp://127.0.0.1", "http://user:pass@127.0.0.1", "http://127.0.0.1/heatmap", "http://127.0.0.1?x=1", "http://127.0.0.1#x", "127.0.0.1:8765", "http://", `http://${"a".repeat(100)}`, "http://127.0.0.1 :8765", 5, null]) assert.equal(parseVisionServiceUrl(bad), undefined, String(bad));
  assert.equal(parseVisionServiceUrl("http://127.0.0.1:8765/")?.origin, "http://127.0.0.1:8765");
  for (const local of ["127.0.0.1", "127.0.5.9", "localhost", "::1"]) assert.equal(isLoopbackHost(local), true, local);
  for (const away of ["192.168.0.5", "10.0.0.1", "vision.local", "0.0.0.0", "127.0.0.1.evil.org"]) assert.equal(isLoopbackHost(away), false, away);
  assert.equal(SECURITY_DEFAULTS["vision.service_url"], "");
  assert.equal(SECURITY_DEFAULTS["vision.service_remote"], false);
  assert.equal(lowers("vision.service_remote", false, true), true);
  assert.equal(lowers("vision.service_remote", true, false), false);
  assert.equal(lowers("vision.service_url", "http://127.0.0.1:8765", "http://192.168.0.5:8765"), true);
  assert.equal(lowers("vision.service_url", "http://192.168.0.5:8765", "http://127.0.0.1:8765"), false);
  assert.equal(lowers("vision.service_url", "", "http://localhost:8765"), false);
  const service = vision();
  const running = await startServer({ ...projects().env, ARMOR_VISION_SERVICE_URL: "" }, { fetchVision: service.fetch });
  try {
    const admin = await studioCookie(running.base);
    const who = await accounts(running, admin);
    for (const role of ["operator", "viewer", "panel"]) assert.ok((await turn(running, who[role], { "vision.service_url": "http://127.0.0.1:8765" })).status >= 401, role);
    for (const bad of ["ftp://x", "http://u:p@127.0.0.1", "http://127.0.0.1/x", 5, true]) assert.equal((await turn(running, admin, { "vision.service_url": bad })).status, 400, String(bad));
    assert.equal((await turn(running, admin, { "vision.service_remote": "yes" })).status, 400);
    await turn(running, admin, { "vision.heatmap": true });
    assert.equal((await ask(running, ROUTES.heatmap, { cookie: admin })).status, 503, "not set up");
    assert.equal((await turn(running, admin, { "vision.service_url": "http://192.168.0.50:8765" })).status, 200);
    assert.equal((await ask(running, ROUTES.heatmap, { cookie: admin })).status, 503, "another machine and the remote switch is off");
    assert.deepEqual(service.calls, []);
    assert.equal((await turn(running, admin, { "vision.service_remote": true })).status, 200);
    assert.equal((await ask(running, ROUTES.heatmap, { cookie: admin })).status, 200, "the switch lets it go to another machine");
    assert.equal(service.calls[0], "http://192.168.0.50:8765/heatmap?format=json&scale=16");
    assert.equal((await turn(running, admin, { "vision.service_url": "http://127.0.0.1:8765", "vision.service_remote": false })).status, 200);
    assert.equal((await ask(running, ROUTES.heatmap, { cookie: admin })).status, 200);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /"target":"vision.service_remote"[^\n]*false -> true/);
    assert.match(audit, /"target":"vision.service_url"/);
    const stored = JSON.parse(fs.readFileSync(path.join(running.config.dataDir, "security-settings.json"), "utf8")).settings;
    assert.equal(stored["vision.service_url"], "http://127.0.0.1:8765");
  } finally { await running.stop(); }
  await assert.rejects(startServer({ ...projects().env, ARMOR_VISION_SERVICE_URL: "gopher://x" }), /ARMOR_VISION_SERVICE_URL/);
});

test("the request to the live service carries nothing of this server: no header, no cookie, no token", async () => {
  const seen: Array<{ headers: Record<string, string | string[] | undefined>; url: string | undefined }> = [];
  const fake = http.createServer((request, response) => {
    seen.push({ headers: request.headers, url: request.url });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(MAP));
  });
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as { port: number }).port;
  const running = await startServer({ ...projects().env, ARMOR_VISION_SERVICE_URL: `http://127.0.0.1:${port}` });
  try {
    const admin = await studioCookie(running.base);
    await turn(running, admin, { "vision.heatmap": true });
    const answer = await ask(running, `${ROUTES.heatmap}?camera=cam-front`, { cookie: admin });
    assert.equal(answer.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "/heatmap?camera=cam-front&format=json&scale=16");
    assert.deepEqual(Object.keys(seen[0]!.headers).filter(name => /authorization|cookie|token|armor/i.test(name)), []);
    // a service that never answers ends in a 502 inside the time limit
    fake.removeAllListeners("request");
    fake.on("request", () => undefined);
    await turn(running, admin, { "reports.timeout_s": 5 });
    const direct = await heatmap({ url: `http://127.0.0.1:${port}`, remote: false, fetch: (await import("../src/reports.js")).fetchVisionService, timeoutMs: 300 }, { format: "json", scale: "16" });
    assert.deepEqual(direct, { status: 502, json: { error: "heatmap_failed" } });
  } finally { await running.stop(); fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve())); }
});

// ------------------------------------------------------------------ with the real projects, when they are next to this one

const python = process.platform === "win32" ? "python" : "python3";
const ready = fs.existsSync(path.join(SIBLINGS, "ARMOR-SERVER-AI", "src", "armor_server_ai", "daily.py")) && fs.existsSync(path.join(SIBLINGS, "ARMOR-VISION", "src", "armor_vision", "service.py")) && spawnSync(python, ["--version"]).status === 0;

test("with the real ARMOR-SERVER-AI and the live ARMOR-VISION service the two reports come out", { skip: ready ? false : "the Python projects are not checked out next to this repository (or there is no Python)" }, async () => {
  const dir = tempDir(), root = tempDir();
  const day = "2026-03-05";
  fs.writeFileSync(path.join(dir, "alarms.json"), JSON.stringify({ schema: 1, counter: 3, alarms: [
    { id: "1", key: "k1", source: { type: "node", id: "radar-1" }, severity: "critical", code: "intrusion", raised_at: `${day}T10:00:00.000Z`, detail: { zone: "garden" } },
    { id: "2", key: "k2", source: { type: "node", id: "radar-1" }, severity: "warning", code: "low_battery", raised_at: `${day}T11:00:00.000Z` },
  ] }));
  const summaryConfig = path.join(root, "summary.json"), activity = path.join(root, "activity.json"), serviceConfig = path.join(root, "service.json");
  fs.writeFileSync(summaryConfig, JSON.stringify({ enabled: true, language: "en" }));
  fs.writeFileSync(activity, JSON.stringify({ enabled: true, heatmap: { cols: 4, rows: 3 } }));
  // a free port for the live service
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  fs.writeFileSync(serviceConfig, JSON.stringify({ port }));
  const child = spawn(python, ["-m", "armor_vision", "serve", "--activity-config", activity, "--service-config", serviceConfig], { env: { ...commandEnv(path.join(SIBLINGS, "ARMOR-VISION", "src")) }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (let tries = 0; tries < 100; tries += 1) {
      const up = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false);
      if (up) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const i of [0, 1, 2]) {
      const posted = await fetch(`http://127.0.0.1:${port}/ingest`, { method: "POST", headers: json, body: JSON.stringify({ camera_id: "cam-front", timestamp: i, detections: [{ label: "person", confidence: 0.9, box: [0.4, 0.6, 0.5, 0.8] }] }) });
      assert.equal(posted.status, 200);
    }
    const running = await startServer({ ARMOR_DATA_DIR: dir, ARMOR_PYTHON: python, ARMOR_DAILY_SUMMARY_AI_DIR: path.join(SIBLINGS, "ARMOR-SERVER-AI"), ARMOR_DAILY_SUMMARY_CONFIG: summaryConfig, ARMOR_VISION_SERVICE_URL: `http://127.0.0.1:${port}` });
    try {
      const admin = await studioCookie(running.base);
      assert.equal((await ask(running, `${ROUTES.summary}?date=${day}`, { cookie: admin })).status, 404, "off until it is turned on");
      await turn(running, admin, { "summary.daily": true, "vision.heatmap": true });
      const summary = await ask(running, `${ROUTES.summary}?date=${day}&lang=es`, { cookie: admin });
      assert.equal(summary.status, 200);
      const report = (await summary.json()) as { date: string; language: string; summary: { totals: { events: number; serious_alarms: number }; by_hour: number[] }; text: string };
      assert.equal(report.language, "es");
      assert.deepEqual([report.summary.totals.events, report.summary.totals.serious_alarms, report.summary.by_hour[10]], [2, 1, 1]);
      assert.ok(report.text.length > 10);
      const map = await ask(running, `${ROUTES.heatmap}?camera=cam-front`, { cookie: admin });
      assert.equal(map.status, 200);
      const grid = (await map.json()) as { cols: number; rows: number; accepted_positions: number; contains_images: boolean };
      assert.deepEqual([grid.cols, grid.rows, grid.accepted_positions, grid.contains_images], [4, 3, 3, false]);
      const png = await ask(running, `${ROUTES.heatmap}?camera=cam-front&format=png`, { cookie: admin });
      assert.equal(png.headers.get("content-type"), "image/png");
      assert.equal((await ask(running, `${ROUTES.heatmap}?camera=nobody`, { cookie: admin })).status, 404);
      await fetch(`http://127.0.0.1:${port}/ingest`, { method: "POST", headers: json, body: JSON.stringify({ camera_id: "cam-front", timestamp: 9, detections: [{ label: "person", confidence: 0.9, box: [0.1, 0.5, 0.2, 0.9] }] }) });
      const later = (await (await ask(running, `${ROUTES.heatmap}?camera=cam-front`, { cookie: admin })).json()) as { accepted_positions: number };
      assert.equal(later.accepted_positions, 4, "the service keeps counting: nothing is replayed");
    } finally { await running.stop(); }
  } finally { child.kill(); }
});
