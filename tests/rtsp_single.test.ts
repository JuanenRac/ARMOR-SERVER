import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";
import { forgetDigestMemory } from "../src/cameras/digest.js";
import { parseCameraInput } from "../src/cameras/model.js";
import { rtspBanner, rtspDescribe } from "../src/cameras/rtsp.js";

const base = { id: "cam-1", name: "Gate", host: "127.0.0.1", username: "admin", password: "s3cret", rtspPath: "/live", onvifPort: 80 };

async function serve(handler: (socket: Socket, request: string) => void): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer(socket => {
    let pending = "";
    socket.on("error", () => undefined);
    socket.on("data", chunk => {
      pending += chunk.toString("latin1");
      let end: number;
      while ((end = pending.indexOf("\r\n\r\n")) >= 0) {
        const head = pending.slice(0, end); pending = pending.slice(end + 4);
        requests.push(head);
        handler(socket, head);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, requests };
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const camera = (port: number) => parseCameraInput({ ...base, rtspPort: port })!;

test("the banner is the Server header of the answer, trimmed, and empty when there is none", async () => {
  const withBanner = await serve(socket => socket.write("RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer:   H264DVR 1.0  \r\n\r\n"));
  const without = await serve(socket => socket.write("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n"));
  try {
    assert.equal(await rtspBanner("127.0.0.1", withBanner.port), "H264DVR 1.0");
    assert.match(withBanner.requests[0]!, /^OPTIONS rtsp:\/\/127\.0\.0\.1:\d+\/ RTSP\/1\.0\r\nCSeq: 1$/);
    assert.equal(await rtspBanner("127.0.0.1", without.port), "");
  } finally { await close(withBanner.server); await close(without.server); }
});

test("a banner of a camera that is silent comes back empty at the end of the time, and one that refuses the connection at once", async () => {
  const silent = await serve(() => undefined);
  try {
    const started = Date.now();
    assert.equal(await rtspBanner("127.0.0.1", silent.port, 150), "");
    assert.ok(Date.now() - started >= 100);
  } finally { await close(silent.server); }
  const gone = await serve(() => undefined);
  const port = gone.port;
  await close(gone.server);
  assert.equal(await rtspBanner("127.0.0.1", port, 1000), "");
});

test("a DESCRIBE with the camera's login only in the header: the address of the request never carries it", async () => {
  forgetDigestMemory();
  const camp = await serve(socket => socket.write("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n"));
  try {
    assert.equal(await rtspDescribe(camera(camp.port), "/live"), 200);
    assert.match(camp.requests[0]!, /^DESCRIBE rtsp:\/\/127\.0\.0\.1:\d+\/live RTSP\/1\.0/);
    assert.ok(!/admin|s3cret/.test(camp.requests[0]!), "no userinfo in the URI and no header without being asked");
  } finally { await close(camp.server); }
});

test("a Basic challenge is answered once with the login, and the status of the second answer is the result", async () => {
  forgetDigestMemory();
  const expected = `Basic ${Buffer.from("admin:s3cret").toString("base64")}`;
  const camp = await serve((socket, head) => {
    if (head.includes(`Authorization: ${expected}`)) socket.write("RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n");
    else socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n');
  });
  try {
    assert.equal(await rtspDescribe(camera(camp.port), "/live"), 200);
    assert.equal(camp.requests.length, 2);
    assert.match(camp.requests[1]!, /CSeq: 2/);
  } finally { await close(camp.server); }
});

test("a wrong login is tried once: the second 401 is the answer, not a loop", async () => {
  forgetDigestMemory();
  const camp = await serve(socket => socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="cam", nonce="abc"\r\n\r\n'));
  try {
    assert.equal(await rtspDescribe(camera(camp.port), "/live"), 401);
    assert.equal(camp.requests.length, 2);
    assert.match(camp.requests[1]!, /Authorization: Digest /);
  } finally { await close(camp.server); }
});

test("a 401 without a challenge that can be answered ends at once, and a 404 is reported as it is", async () => {
  forgetDigestMemory();
  const noChallenge = await serve(socket => socket.write("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n"));
  const missing = await serve(socket => socket.write("RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n"));
  try {
    assert.equal(await rtspDescribe(camera(noChallenge.port), "/live"), 401);
    assert.equal(noChallenge.requests.length, 1);
    assert.equal(await rtspDescribe(camera(missing.port), "/nothing"), 404);
    // text that is not RTSP gives status 0
    const odd = await serve(socket => socket.write("HTTP/1.1 200 OK\r\n\r\n"));
    try { assert.equal(await rtspDescribe(camera(odd.port), "/live"), 0); } finally { await close(odd.server); }
  } finally { await close(noChallenge.server); await close(missing.server); }
});

test("without a login nothing is sent at all, a silent camera times out and a closed port is an error", async () => {
  const camp = await serve(() => undefined);
  try {
    const anonymous = parseCameraInput({ ...base, username: "", password: "", rtspPort: camp.port });
    if (anonymous) await assert.rejects(rtspDescribe({ ...anonymous, secrets: undefined }, "/live"), /missing RTSP credentials/);
    assert.equal(camp.requests.length, 0);
    await assert.rejects(rtspDescribe(camera(camp.port), "/live", 150), /RTSP timeout/);
  } finally { await close(camp.server); }
  const gone = await serve(() => undefined);
  const port = gone.port;
  await close(gone.server);
  await assert.rejects(rtspDescribe(camera(port), "/live", 1000));
});
