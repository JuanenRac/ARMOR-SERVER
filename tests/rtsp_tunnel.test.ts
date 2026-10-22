import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { AiGateway } from "../src/ai.js";
import { digestAuthorization, parseDigestChallenge } from "../src/cameras/digest.js";
import type { CameraConnection } from "../src/cameras/model.js";
import { openRtspTunnel, RtspFramer } from "../src/cameras/rtsp_tunnel.js";
import { EvidenceLibrary } from "../src/media/evidence.js";
import { RelayManager } from "../src/media/relay.js";
import { tempDir } from "./helpers.js";

const USER = "installer", PASSWORD = "s3cret-pw!";
const cameraAt = (port: number, extra: Partial<CameraConnection> = {}): CameraConnection => ({ id: "cam-1", name: "Gate", host: "127.0.0.1", snapshotUrl: "", rtspPath: "live/main", previewPath: "live/sub", onvifPort: 80, rtspPort: port, secrets: { username: USER, password: PASSWORD }, ...extra });
const PICTURE = Buffer.from([0x24, 0, 0, 3, 1, 2, 3]);

/** A camera that asks for a login on every request that has none and checks the answers; it records what it was asked. */
function fakeCamera(mode: "digest" | "basic" = "digest") {
  const seen: Array<{ request: string; authorization?: string; valid: boolean }> = [];
  const nonce = "abcdef0123456789";
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");
      for (let end = buffer.indexOf("\r\n\r\n"); end >= 0; end = buffer.indexOf("\r\n\r\n")) {
        const head = buffer.slice(0, end); buffer = buffer.slice(end + 4);
        const line = head.split("\r\n")[0]!;
        const [method, uri] = line.split(" ");
        const cseq = /CSeq:\s*(\d+)/i.exec(head)?.[1] ?? "0";
        const authorization = /^Authorization:\s*(.+)$/im.exec(head)?.[1];
        let valid = false;
        if (authorization && mode === "basic") valid = authorization === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
        if (authorization && mode === "digest") {
          const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(authorization)?.[1] ?? "";
          const challenge = parseDigestChallenge(`Digest realm="armor", nonce="${nonce}", qop="auth"`)!;
          valid = field("uri") === uri && authorization === digestAuthorization(challenge, { username: USER, password: PASSWORD, method: method!, uri: uri!, nonceCount: parseInt(field("nc"), 16), cnonce: field("cnonce") });
        }
        seen.push({ request: line, authorization, valid });
        if (!valid) {
          const challenge = mode === "digest" ? `Digest realm="armor", nonce="${nonce}", qop="auth"` : `Basic realm="armor"`;
          socket.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: ${challenge}\r\n\r\n`);
        } else {
          const body = "v=0\r\n";
          socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
          socket.write(PICTURE);   // a picture of the stream, interleaved, right behind the answer
        }
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() })));
}

/** Sends one request to the tunnel and collects what comes back until a picture arrives, the door closes or a few seconds pass. */
const talk = (url: string, lines: string[]) => new Promise<Buffer>((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) }, () => { socket.write(lines.join("\r\n") + "\r\n\r\n"); });
  const chunks: Buffer[] = [];
  const done = () => { clearTimeout(timer); socket.destroy(); resolve(Buffer.concat(chunks)); };
  const timer = setTimeout(done, 3000);
  socket.on("data", chunk => { chunks.push(chunk); if (Buffer.concat(chunks).includes(PICTURE) || /^RTSP\/1\.0 401/.test(Buffer.concat(chunks).toString("latin1"))) done(); });
  socket.on("close", done);
  socket.on("error", error => { clearTimeout(timer); reject(error); });
});

test("the tunnel address carries no login, and the camera gets a valid Digest answer without FFmpeg ever seeing a 401", async () => {
  const camera = await fakeCamera("digest");
  const tunnel = (await openRtspTunnel(cameraAt(camera.port)))!;
  try {
    assert.match(tunnel.url, /^rtsp:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}$/);
    assert.ok(!tunnel.url.includes(USER) && !tunnel.url.includes("@") && !tunnel.url.includes("pw"));
    const answer = await talk(tunnel.url, [`DESCRIBE ${tunnel.url} RTSP/1.0`, "CSeq: 1", "Accept: application/sdp"]);
    assert.match(answer.toString("latin1"), /^RTSP\/1\.0 200 OK/, "the 401 was answered inside the tunnel");
    assert.ok(answer.includes(PICTURE), "the picture goes through untouched");
    assert.equal(camera.seen.length, 2, "one request without login, one with it");
    assert.equal(camera.seen[0]!.authorization, undefined);
    assert.equal(camera.seen[1]!.valid, true);
    assert.equal(camera.seen[1]!.request, `DESCRIBE rtsp://127.0.0.1:${camera.port}/live/main RTSP/1.0`, "the camera is asked for its own address");
  } finally { tunnel.close(); camera.close(); }
});

test("the tunnel answers a Basic challenge too, and a wrong first word closes the door", async () => {
  const camera = await fakeCamera("basic");
  const tunnel = (await openRtspTunnel(cameraAt(camera.port)))!;
  try {
    const wrong = await talk(tunnel.url.replace(/\/[^/]+$/, "/not-the-word"), ["DESCRIBE rtsp://127.0.0.1:1/not-the-word RTSP/1.0", "CSeq: 1"]);
    assert.equal(wrong.length, 0, "nothing comes back");
    assert.equal(camera.seen.length, 0, "and the camera was not even asked");
    const answer = await talk(tunnel.url, [`DESCRIBE ${tunnel.url} RTSP/1.0`, "CSeq: 1"]);
    assert.match(answer.toString("latin1"), /^RTSP\/1\.0 200 OK/);
  } finally { tunnel.close(); camera.close(); }
});

test("a wrong password reaches FFmpeg as the camera's own 401 and is not tried again", async () => {
  const camera = await fakeCamera("digest");
  const tunnel = (await openRtspTunnel(cameraAt(camera.port, { secrets: { username: USER, password: "wrong" } })))!;
  try {
    const answer = await talk(tunnel.url, [`DESCRIBE ${tunnel.url} RTSP/1.0`, "CSeq: 1"]);
    assert.match(answer.toString("latin1"), /^RTSP\/1\.0 401/);
    assert.equal(camera.seen.length, 2);
  } finally { tunnel.close(); camera.close(); }
});

test("the door lets in only the sessions it was opened for and is gone with the process", async () => {
  const camera = await fakeCamera("digest");
  const tunnel = (await openRtspTunnel(cameraAt(camera.port), { maxSessions: 1 }))!;
  const port = Number(new URL(tunnel.url).port);
  const connect = () => new Promise<boolean>(resolve => { const socket = net.createConnection({ host: "127.0.0.1", port }); socket.once("connect", () => resolve(true)); socket.once("error", () => resolve(false)); socket.unref(); });
  const first = net.createConnection({ host: "127.0.0.1", port });
  await new Promise(resolve => first.once("connect", resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await connect(), false, "the only session is taken: the port no longer answers");
  tunnel.close();
  first.destroy(); camera.close();
  assert.equal(await connect(), false);
});

test("a camera without a stream path or a login has no tunnel", async () => {
  assert.equal(await openRtspTunnel(cameraAt(554, { rtspPath: "" })), null);
  assert.equal(await openRtspTunnel(cameraAt(554, { secrets: undefined })), null);
});

test("the framer cuts messages and pictures however the bytes arrive", () => {
  const framer = new RtspFramer();
  const stream = Buffer.concat([Buffer.from("RTSP/1.0 200 OK\r\nContent-Length: 3\r\n\r\nabc"), Buffer.from([0x24, 1, 0, 2, 9, 9]), Buffer.from("OPTIONS * RTSP/1.0\r\nCSeq: 2\r\n\r\n")]);
  const units: string[] = [];
  for (let at = 0; at < stream.length; at += 5) for (const unit of framer.push(stream.subarray(at, at + 5))) units.push(unit.kind === "frame" ? `frame:${unit.raw.length}` : `message:${unit.head.split("\r\n")[0]}:${unit.body.length}`);
  assert.deepEqual(units, ["message:RTSP/1.0 200 OK:3", "frame:6", "message:OPTIONS * RTSP/1.0:0"]);
  assert.throws(() => new RtspFramer().push(Buffer.alloc(70_000, 0x41)), /too long/);
});

// ---- what FFmpeg is given -------------------------------------------------------------------------------------------------------------------------

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = { writable: true, write: () => true };
  constructor() { super(); setTimeout(() => this.emit("close", 1), 150).unref(); }
  kill() { setImmediate(() => this.emit("close", 0)); return true; }
}
const fakeSpawn = (calls: string[][]) => ((_program: string, args: string[]) => { calls.push(args); return new FakeProcess(); }) as never;
const noLogin = (args: string[]) => {
  const line = args.join(" ");
  assert.ok(!line.includes(USER), "the user name is not in the arguments of FFmpeg");
  assert.ok(!line.includes(PASSWORD) && !line.includes(encodeURIComponent(PASSWORD)), "the password is not in the arguments of FFmpeg");
  assert.ok(!line.includes("@"), "there is no login in any address");
  assert.match(line, /-i rtsp:\/\/127\.0\.0\.1:\d+\//, "FFmpeg reads the tunnel");
};

test("the live relay, the snapshot, the recording and the frame of the observer never give FFmpeg the camera login", async () => {
  const camera = cameraAt(1);   // nothing listens there: FFmpeg never gets as far as the camera in this test
  const calls: string[][] = [];
  const relays = new RelayManager({ ffmpegPath: "ffmpeg", maxRelays: 2, spawn: fakeSpawn(calls) });
  const viewer = { write: () => true, end: () => undefined, writableEnded: false, writableNeedDrain: false };
  const detach = relays.attach(camera, viewer as never);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
  noLogin(calls[0]!);
  detach(); relays.stop(camera.id);

  const library = new EvidenceLibrary({ root: path.join(tempDir(), "media"), ffmpegPath: "ffmpeg", spawn: fakeSpawn(calls), maxBytes: 1e9, retentionMs: 0 });
  await assert.rejects(library.snapshot(camera));   // the fake produces no file; what matters is what it was given
  assert.equal(calls.length, 2);
  noLogin(calls[1]!);
  await library.startRecording(camera);
  assert.equal(calls.length, 3);
  noLogin(calls[2]!);

  const seen: string[][] = [];
  const gateway = new AiGateway({ ffmpegPath: "ffmpeg", run: async (_program, args) => { seen.push(args); return Buffer.alloc(64 * 36); } });
  await gateway.frame(camera);
  assert.equal(seen.length, 1);
  noLogin(seen[0]!);
});

test("with media.rtsp_proxy off FFmpeg is given the camera address as before", async () => {
  const camera = cameraAt(1);
  const seen: string[][] = [];
  const gateway = new AiGateway({ ffmpegPath: "ffmpeg", proxy: () => false, run: async (_program, args) => { seen.push(args); return Buffer.alloc(64 * 36); } });
  await gateway.frame(camera);
  assert.match(seen[0]!.join(" "), new RegExp(`rtsp://${USER}:${encodeURIComponent(PASSWORD)}@127\\.0\\.0\\.1:1/live/sub`));
});
