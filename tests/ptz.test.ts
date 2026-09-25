import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { hi3510Confirmed, movePtz, psiaConfirmed, PtzController } from "../src/cameras/ptz.js";
import type { CameraConnection } from "../src/cameras/model.js";

type Behaviour = (request: http.IncomingMessage, response: http.ServerResponse) => void;

/** A stand-in for a camera's web interface; records every request it receives. */
async function fakeCamera(behaviour: Behaviour): Promise<{ camera: CameraConnection; requests: string[]; stop: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => { requests.push(`${request.method} ${request.url}`); request.resume(); behaviour(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    camera: { id: "cam-test", name: "Test", host: "127.0.0.1", snapshotUrl: "", rtspPath: "", onvifPort: port, rtspPort: 554, secrets: { username: "admin", password: "secret-pw" } },
    stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("a Hi3510 camera moves when it answers in its own words, and the command carries the right action", async () => {
  const fake = await fakeCamera((_request, response) => { response.statusCode = 200; response.end("[Succeed]set ok."); });
  try {
    await movePtz(fake.camera, "left");
    await movePtz(fake.camera, "zoomIn");
    await movePtz(fake.camera, "stop");
    assert.deepEqual(fake.requests.map(line => /-act=(\w+)/.exec(line)?.[1]), ["left", "zoomin", "stop"]);
    assert.ok(fake.requests.every(line => line.startsWith("GET /cgi-bin/hi3510/ptzctrl.cgi?-step=0&")));
  } finally { await fake.stop(); }
});

test("an empty 200 is not a confirmation: a camera without PTZ is reported as such", async () => {
  const fake = await fakeCamera((_request, response) => { response.statusCode = 200; response.end(""); });
  try {
    await assert.rejects(() => movePtz(fake.camera, "left"), /accepts no PTZ command/);
    assert.ok(fake.requests.some(line => line.startsWith("PUT /PSIA/")), "PSIA was tried after Hi3510");
    assert.ok(fake.requests.some(line => line.includes("/onvif/")), "ONVIF was tried last");
  } finally { await fake.stop(); }
});

test("a refused login and an unreachable camera are reported as what they are, quickly", async () => {
  const locked = await fakeCamera((_request, response) => { response.statusCode = 401; response.setHeader("WWW-Authenticate", 'Basic realm="cgi-bin/hi3510/ptzctrl.cgi"'); response.end("<html>Login</html>"); });
  try {
    const started = Date.now();
    await assert.rejects(() => movePtz(locked.camera, "up"), /refused the stored login/);
    assert.ok(Date.now() - started < 3_000, "it must not wait for a slow ONVIF attempt");
    assert.ok(!locked.requests.some(line => line.includes("/onvif/")));
  } finally { await locked.stop(); }
  const gone = await fakeCamera((_request, response) => response.end());
  const dead = { ...gone.camera };
  await gone.stop();
  await assert.rejects(() => movePtz(dead, "up"), /did not answer/);
});

test("only a camera's own confirmation counts", () => {
  assert.equal(hi3510Confirmed({ status: 200, body: "[Succeed]set ok." }), true);
  assert.equal(hi3510Confirmed({ status: 200, body: "" }), false);
  assert.equal(hi3510Confirmed({ status: 200, body: "<html>Login</html>" }), false);
  assert.equal(hi3510Confirmed({ status: 500, body: "[Succeed]" }), false);
  assert.equal(psiaConfirmed({ status: 200, body: "<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>" }), true);
  assert.equal(psiaConfirmed({ status: 200, body: "<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString></ResponseStatus>" }), false);
  assert.equal(psiaConfirmed({ status: 200, body: "" }), false);
});

test("a move stops itself, an explicit stop cancels that, and a repeated move keeps one timer", async () => {
  const sent: string[] = [];
  const controller = new PtzController({ maxMoveMs: 60, move: async (_camera, command) => { sent.push(String(command)); } });
  const camera = { id: "cam-test", name: "Test", host: "127.0.0.1", snapshotUrl: "", rtspPath: "", onvifPort: 80, rtspPort: 554 } as CameraConnection;
  await controller.move(camera, "left");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(sent, ["left", "stop"], "the watchdog stopped a move nobody stopped");

  sent.length = 0;
  await controller.move(camera, "right");
  await controller.move(camera, "stop");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(sent, ["right", "stop"], "an explicit stop leaves no second stop behind");

  sent.length = 0;
  await controller.move(camera, "up");
  await new Promise(resolve => setTimeout(resolve, 40));
  await controller.move(camera, "up");   // a held button repeats: the deadline moves forward
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(sent, ["up", "up"], "still moving: not stopped yet");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(sent, ["up", "up", "stop"]);

  sent.length = 0;
  await controller.move(camera, "down");
  controller.close();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(sent, ["down"], "closing the controller cancels pending stops");
});

test("a failed move does not leave a stop timer behind", async () => {
  const sent: string[] = [];
  const controller = new PtzController({ maxMoveMs: 30, move: async (_camera, command) => { sent.push(String(command)); throw new Error("refused"); } });
  const camera = { id: "cam-test" } as CameraConnection;
  await assert.rejects(() => controller.move(camera, "left"), /refused/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(sent, ["left"]);
});
