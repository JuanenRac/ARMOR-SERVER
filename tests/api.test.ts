import assert from "node:assert/strict";
import { connect } from "node:net";
import path from "node:path";
import fs from "node:fs";
import test, { after, before } from "node:test";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

let server: Running;
let cookie: string;
const json = (body: unknown) => ({ "Content-Type": "application/json", body: JSON.stringify(body) });
const call = (route: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
  const { cookie: sessionCookie, bearer, headers, ...rest } = init;
  return fetch(`${server.base}${route}`, { ...rest, headers: { ...(headers as Record<string, string>), ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
};
const post = (route: string, body: unknown, extra: { cookie?: string; bearer?: string } = {}) => {
  const { body: payload, ...headers } = json(body);
  return call(route, { method: "POST", headers, body: payload, ...extra });
};

before(async () => { server = await startServer(); cookie = await studioCookie(server.base); });
after(async () => { await server.stop(); });

const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "hunter2-secret", rtspPath: "/live" };

test("health is public and status is readable", async () => {
  assert.deepEqual(await (await call("/healthz")).json(), { ok: true, service: "armor-server" });
  // The perimeter state is for operators: a stranger learns nothing about whether the system is armed.
  assert.equal((await call("/api/v1/status")).status, 401);
  const status = await (await call("/api/v1/status", { cookie })).json() as { mode: string };
  assert.equal(status.mode, "disarmed");
  const anonymous = await (await call("/api/v1/info")).json() as Record<string, unknown>;
  assert.equal(anonymous.version, "test");
  assert.equal("mode" in anonymous, false);
  assert.equal("live_video" in anonymous, false);
  const info = await (await call("/api/v1/info", { cookie })).json() as { version: string; live_video: boolean; mode: string };
  assert.equal(info.mode, "disarmed");
  assert.equal(info.live_video, false);
});

test("responses carry security headers and never advertise Express", async () => {
  const response = await call("/healthz");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("every operator route refuses an anonymous caller", async () => {
  const routes: [string, string][] = [
    ["GET", "/api/v1/cameras"], ["POST", "/api/v1/cameras/configure"], ["DELETE", "/api/v1/cameras/cam-gate"], ["POST", "/api/v1/cameras/discover"],
    ["POST", "/api/v1/cameras/cam-gate/ptz"], ["POST", "/api/v1/cameras/cam-gate/discover-rtsp"], ["POST", "/api/v1/cameras/cam-gate/stream-ticket"],
    ["POST", "/api/v1/cameras/cam-gate/snapshot"], ["POST", "/api/v1/cameras/cam-gate/recordings/start"], ["POST", "/api/v1/cameras/cam-gate/recordings/stop"],
    ["GET", "/api/v1/media"], ["GET", "/api/v1/media/cam-gate/snapshots/a.jpg"], ["GET", "/api/v1/media/cam-gate/snapshots/a.jpg/sha256"],
    ["PUT", "/api/v1/media/cam-gate/snapshots/a.jpg/protected"], ["DELETE", "/api/v1/media/cam-gate/snapshots/a.jpg"], ["DELETE", "/api/v1/media"],
  ];
  for (const [method, route] of routes) assert.equal((await call(route, { method })).status, 401, `${method} ${route}`);
});

test("a wrong Studio login is refused and never sets a cookie", async () => {
  const response = await post("/api/v1/studio/session", { username: "admin", password: "wrong-password!" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal((await post("/api/v1/studio/session", { username: 5, password: null })).status, 401);
});

test("the Studio session cookie is HttpOnly and strict, and signs out", async () => {
  const login = await post("/api/v1/studio/session", { username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD });
  const setCookie = login.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const own = setCookie.split(";")[0];
  const who = await (await call("/api/v1/studio/session", { cookie: own })).json() as { authenticated: boolean; user?: { username: string; role: string } };
  assert.equal(who.authenticated, true);
  assert.deepEqual({ username: who.user?.username, role: who.user?.role }, { username: SECRETS.ARMOR_STUDIO_USERNAME, role: "admin" });
  assert.equal((await call("/api/v1/studio/session", { method: "DELETE", cookie: own })).status, 204);
  assert.deepEqual(await (await call("/api/v1/studio/session", { cookie: own })).json(), { authenticated: false });
});

test("the operator token opens an operator session and a wrong one does not", async () => {
  assert.equal((await post("/api/v1/operator/session", {}, { bearer: "wrong" + "x".repeat(30) })).status, 401);
  const opened = await post("/api/v1/operator/session", {}, { bearer: SECRETS.ARMOR_OPERATOR_TOKEN });
  assert.equal(opened.status, 201);
  const own = opened.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await call("/api/v1/cameras", { cookie: own })).status, 200);
  assert.equal((await call("/api/v1/cameras", { bearer: SECRETS.ARMOR_OPERATOR_TOKEN })).status, 200);
  assert.equal((await call("/api/v1/cameras", { bearer: SECRETS.ARMOR_INGEST_TOKEN })).status, 401);
});

test("camera lifecycle: configure, list without the password, view without the username, remove", async () => {
  const configured = await post("/api/v1/cameras/configure", camera, { cookie });
  assert.equal(configured.status, 200);
  const stored = await configured.json() as Record<string, unknown>;
  assert.equal(stored.hasCredentials, true);
  assert.equal(stored.username, "admin");
  assert.doesNotMatch(JSON.stringify(stored), /hunter2/);

  const listed = JSON.stringify(await (await call("/api/v1/cameras", { cookie })).json());
  assert.doesNotMatch(listed, /hunter2/);
  const views = JSON.stringify(await (await call("/api/v1/camera-views")).json());
  assert.match(views, /cam-gate/);
  assert.doesNotMatch(views, /hunter2|"username"/);

  const onDisk = fs.readFileSync(path.join(server.config.dataDir, "cameras.json"), "utf8");
  assert.doesNotMatch(onDisk, /hunter2/);

  assert.equal((await post("/api/v1/cameras/configure", { ...camera, id: "x" }, { cookie })).status, 400);
  assert.equal((await call("/api/v1/cameras/cam-gate", { method: "DELETE", cookie })).status, 204);
  assert.equal((await call("/api/v1/cameras/cam-gate", { method: "DELETE", cookie })).status, 404);
});

test("a live stream needs an operator or a ticket issued for that camera", async () => {
  await post("/api/v1/cameras/configure", camera, { cookie });
  assert.equal((await call("/api/v1/cameras/cam-gate/mjpeg")).status, 401);
  assert.equal((await call("/api/v1/cameras/cam-gate/mjpeg?ticket=forged")).status, 401);
  assert.equal((await call("/api/v1/cameras/cam-gate/stream-ticket", { method: "POST" })).status, 401);
  const grant = await (await post("/api/v1/cameras/cam-gate/stream-ticket", {}, { cookie })).json() as { path: string };
  assert.match(grant.path, /^\/api\/v1\/cameras\/cam-gate\/mjpeg\?ticket=/);
  // Authorised by ticket; the relay itself is unavailable because FFmpeg is not configured.
  const withTicket = await call(grant.path);
  assert.equal(withTicket.status, 503);
  assert.match((await withTicket.json() as { error: string }).error, /FFmpeg is not configured/);
  assert.equal((await call("/api/v1/cameras/cam-gate/mjpeg", { cookie })).status, 503);
  await post("/api/v1/cameras/configure", { ...camera, id: "cam-other" }, { cookie });
  assert.equal((await call(grant.path.replace("cam-gate", "cam-other"))).status, 401);
});

test("PTZ rejects an unknown command and an unknown camera without touching the network", async () => {
  assert.equal((await post("/api/v1/cameras/cam-nope/ptz", { command: "left" }, { cookie })).status, 404);
  const bad = await post("/api/v1/cameras/cam-gate/ptz", { command: "self-destruct" }, { cookie });
  assert.equal(bad.status, 502);
  assert.match((await bad.json() as { error: string }).error, /invalid PTZ command/);
});

test("capture without FFmpeg reports a clear failure", async () => {
  const snapshot = await post("/api/v1/cameras/cam-gate/snapshot", {}, { cookie });
  assert.equal(snapshot.status, 502);
  assert.match((await snapshot.json() as { error: string }).error, /FFmpeg is not configured/);
  assert.equal((await post("/api/v1/cameras/cam-gate/recordings/stop", {}, { cookie })).status, 409);
});

test("evidence: protect, hash, refuse to delete protected, then delete", async () => {
  const folder = path.join(server.config.dataDir, "media", "cam-gate", "snapshots");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "shot.jpg"), Buffer.alloc(300, 7));
  const catalogue = await (await call("/api/v1/media", { cookie })).json() as { items: { file: string; protected: boolean }[] };
  assert.deepEqual(catalogue.items.map(item => item.file), ["shot.jpg"]);
  assert.equal((await call("/api/v1/media/cam-gate/snapshots/shot.jpg", { cookie })).headers.get("content-type"), "image/jpeg");
  const hash = await (await call("/api/v1/media/cam-gate/snapshots/shot.jpg/sha256", { cookie })).json() as { sha256: string };
  assert.match(hash.sha256, /^[0-9a-f]{64}$/);
  const protect = (value: unknown) => call("/api/v1/media/cam-gate/snapshots/shot.jpg/protected", { method: "PUT", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protected: value }) });
  assert.equal((await protect("yes")).status, 400);
  assert.equal((await protect(true)).status, 204);
  assert.equal((await call("/api/v1/media/cam-gate/snapshots/shot.jpg", { method: "DELETE", cookie })).status, 409);
  assert.equal((await protect(false)).status, 204);
  assert.equal((await call("/api/v1/media/cam-gate/snapshots/shot.jpg", { method: "DELETE", cookie })).status, 204);
  assert.equal((await call("/api/v1/media/cam-gate/snapshots/..%2F..%2Fcameras.json", { cookie })).status, 404);
  assert.equal((await call("/api/v1/media", { method: "DELETE", cookie, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "everything" }) })).status, 400);
});

test("ingest needs the ingest token and validates the payload", async () => {
  const reading = { node_id: "north-1", timestamp_ms: 5, lux: 200, targets: [{ sensor_id: 1, track_id: 1, x_mm: 1, y_mm: 2, speed_mm_s: 3 }] };
  assert.equal((await post("/api/v1/telemetry", reading)).status, 401);
  assert.equal((await post("/api/v1/telemetry", reading, { bearer: SECRETS.ARMOR_CONTROL_TOKEN })).status, 401);
  assert.equal((await post("/api/v1/telemetry", { ...reading, lux: -1 }, { bearer: SECRETS.ARMOR_INGEST_TOKEN })).status, 400);
  const accepted = await post("/api/v1/telemetry", reading, { bearer: SECRETS.ARMOR_INGEST_TOKEN });
  assert.equal(accepted.status, 202);
  assert.deepEqual(Object.keys(await accepted.json() as object).sort(), ["accepted", "revision"], "a node token must not learn the perimeter state");
  assert.equal((await post("/api/v1/health", { node_id: "north-1", timestamp_ms: 6, online: true }, { bearer: SECRETS.ARMOR_INGEST_TOKEN })).status, 202);
  const status = await (await call("/api/v1/status", { cookie })).json() as { nodes: Record<string, { online: boolean; stale: boolean }> };
  assert.equal(status.nodes["north-1"].online, true);
  assert.equal(status.nodes["north-1"].stale, false);
});

test("arming needs the control token and only accepts arm or disarm", async () => {
  assert.equal((await post("/api/v1/control/arm", {})).status, 401);
  assert.equal((await post("/api/v1/control/arm", {}, { bearer: SECRETS.ARMOR_OPERATOR_TOKEN })).status, 401);
  assert.equal((await post("/api/v1/control/reboot", {}, { bearer: SECRETS.ARMOR_CONTROL_TOKEN })).status, 404);
  const armed = await (await post("/api/v1/control/arm", {}, { bearer: SECRETS.ARMOR_CONTROL_TOKEN })).json() as { mode: string };
  assert.equal(armed.mode, "armed");
  const disarmed = await (await post("/api/v1/control/disarm", {}, { bearer: SECRETS.ARMOR_CONTROL_TOKEN })).json() as { mode: string };
  assert.equal(disarmed.mode, "disarmed");
});

test("malformed JSON gets a plain client error, not a stack trace", async () => {
  const response = await call("/api/v1/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid request" });
});

test("the WebSocket refuses anonymous clients", async () => {
  const port = Number(new URL(server.base).port);
  const answer = await new Promise<string>(resolve => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET /api/v1/events HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
    let data = "";
    socket.on("data", chunk => { data += chunk.toString(); });
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });
  assert.doesNotMatch(answer, /101 Switching/);
});

test("discovery refuses a second concurrent request", async () => {
  const gate = server.app.context.discovery;
  let release!: () => void;
  const running = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
  const response = await post("/api/v1/cameras/discover", {}, { cookie });
  assert.equal(response.status, 429);
  release();
  await running;
});
