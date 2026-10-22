/**
 * A local RTSP door for FFmpeg. FFmpeg only reads a camera's login from the address it is given, and a process's arguments can be read by every user of the machine
 * (`ps`, /proc/<pid>/cmdline). So FFmpeg is given an address on this machine's loopback with no login at all, and this tunnel - inside the server - forwards what
 * FFmpeg says to the camera, adds the login (Basic or Digest) to each request and answers the camera's 401 itself. The login never leaves this process.
 *
 * The door is for one FFmpeg: it listens on a port chosen by the system, only on 127.0.0.1, the address carries a random word that the first request must repeat,
 * it accepts at most `maxSessions` connections and it closes when FFmpeg finishes (or when nobody came in a few seconds). Only TCP-interleaved RTSP is carried
 * (every FFmpeg call here uses `-rtsp_transport tcp`).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { answerChallenge, basicAuthorization, digestAuthorization, parseDigestChallenge, type DigestChallenge } from "./digest.js";
import { rtspUrl, type CameraConnection } from "./model.js";

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

export type RtspUnit =
  | { kind: "frame"; raw: Buffer }
  | { kind: "message"; head: string; body: Buffer };

/** Cuts an RTSP byte stream into interleaved binary frames (`$` channel length data) and text messages (head, blank line, body of Content-Length bytes). */
export class RtspFramer {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RtspUnit[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const units: RtspUnit[] = [];
    for (;;) {
      while (this.#buffer.length && (this.#buffer[0] === 0x0d || this.#buffer[0] === 0x0a)) this.#buffer = this.#buffer.subarray(1);
      if (!this.#buffer.length) break;
      if (this.#buffer[0] === 0x24) {
        if (this.#buffer.length < 4) break;
        const total = 4 + this.#buffer.readUInt16BE(2);
        if (this.#buffer.length < total) break;
        units.push({ kind: "frame", raw: this.#buffer.subarray(0, total) });
        this.#buffer = this.#buffer.subarray(total);
        continue;
      }
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.#buffer.length > MAX_HEAD_BYTES) throw new Error("RTSP message head too long");
        break;
      }
      const head = this.#buffer.subarray(0, end).toString("latin1");
      const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
      if (length > MAX_BODY_BYTES) throw new Error("RTSP message body too long");
      const total = end + 4 + length;
      if (this.#buffer.length < total) break;
      units.push({ kind: "message", head, body: this.#buffer.subarray(end + 4, total) });
      this.#buffer = this.#buffer.subarray(total);
    }
    return units;
  }
}

type PendingRequest = { method: string; uri: string; headers: string[]; body: Buffer; retried: boolean };
type AuthState = { kind: "none" } | { kind: "basic" } | { kind: "digest"; challenge: DigestChallenge; count: number };

export type TunnelTarget = { host: string; port: number; username: string; password: string; remember: string };

/** One FFmpeg connection: requests go to the camera with the login added, responses and media come back untouched (except a 401 that the tunnel answers itself). */
function serveSession(client: Socket, target: TunnelTarget, proxyBase: string, realBase: string, onFirstRequest: (ok: boolean) => void): void {
  const upstream = createConnection({ host: target.host, port: target.port });
  const fromClient = new RtspFramer(), fromCamera = new RtspFramer();
  const pending: PendingRequest[] = [];
  let auth: AuthState = { kind: "none" };
  let first = true;
  const destroy = () => { client.destroy(); upstream.destroy(); };
  const relay = (to: Socket, from: Socket, data: Buffer) => { if (!to.write(data)) { from.pause(); to.once("drain", () => from.resume()); } };

  const authorization = (request: PendingRequest): string | undefined => {
    if (auth.kind === "basic") return basicAuthorization(target.username, target.password);
    if (auth.kind === "digest") { auth.count += 1; return digestAuthorization(auth.challenge, { username: target.username, password: target.password, method: request.method, uri: request.uri, nonceCount: auth.count }); }
    return undefined;
  };
  const send = (request: PendingRequest, header?: string) => {
    const lines = [`${request.method} ${request.uri} RTSP/1.0`, ...request.headers, ...(header ? [`Authorization: ${header}`] : [])];
    upstream.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), request.body]));
  };

  client.on("data", chunk => {
    try {
      for (const unit of fromClient.push(chunk)) {
        if (unit.kind === "frame") { relay(upstream, client, unit.raw); continue; }
        const lines = unit.head.split("\r\n");
        const parts = /^([A-Z_]+) (\S+) RTSP\/1\.0$/.exec(lines[0]);
        if (!parts) {   // an answer to something the camera asked: it goes through as it is
          relay(upstream, client, Buffer.concat([Buffer.from(`${unit.head}\r\n\r\n`, "latin1"), unit.body]));
          continue;
        }
        const requested = parts[2];
        if (first) {
          first = false;
          const ok = requested.startsWith(proxyBase);
          onFirstRequest(ok);
          if (!ok) { destroy(); return; }
        }
        // The address FFmpeg knows is the tunnel's; the camera is asked for its own. A later request may already carry the camera's address (taken from its answer).
        const uri = requested.startsWith(proxyBase) ? realBase + requested.slice(proxyBase.length) : requested;
        const request: PendingRequest = { method: parts[1], uri, headers: lines.slice(1).filter(line => line && !/^authorization:/i.test(line)), body: unit.body, retried: false };
        pending.push(request);
        send(request, authorization(request));
      }
    } catch { destroy(); }
  });

  upstream.on("data", chunk => {
    try {
      for (const unit of fromCamera.push(chunk)) {
        if (unit.kind === "frame") { relay(client, upstream, unit.raw); continue; }
        const raw = Buffer.concat([Buffer.from(`${unit.head}\r\n\r\n`, "latin1"), unit.body]);
        const status = /^RTSP\/1\.0 (\d{3})/.exec(unit.head);
        if (!status) { relay(client, upstream, raw); continue; }   // a request from the camera
        const request = pending[0];
        if (status[1] === "401" && request && !request.retried) {
          const challenges = unit.head.split("\r\n").filter(line => /^www-authenticate:/i.test(line)).map(line => line.slice(line.indexOf(":") + 1).trim());
          const chosen = challenges.find(value => /^Digest\b/i.test(value)) ?? challenges[0];
          const header = answerChallenge(chosen, { username: target.username, password: target.password }, request.method, request.uri, target.remember);
          if (header) {
            const challenge = parseDigestChallenge(chosen);
            auth = challenge ? { kind: "digest", challenge, count: 1 } : { kind: "basic" };
            request.retried = true;
            send(request, header);
            continue;
          }
        }
        pending.shift();
        relay(client, upstream, raw);
      }
    } catch { destroy(); }
  });

  for (const socket of [client, upstream]) { socket.on("error", destroy); socket.on("close", destroy); }
}

export type RtspTunnel = {
  /** The address to give FFmpeg: loopback, no login. */
  url: string;
  close(): void;
};

/** `direct` is the setting media.rtsp_proxy turned off: no tunnel, the address with the camera login is given to FFmpeg as it always was (the login is then visible in the list of processes). */
export type TunnelOptions = { preview?: boolean; maxSessions?: number; idleCloseMs?: number; direct?: boolean };

/** A tunnel to a camera's stream, or null when the camera has no stream path or no complete login. */
export async function openRtspTunnel(camera: CameraConnection, options: TunnelOptions = {}): Promise<RtspTunnel | null> {
  if (options.direct) { const url = rtspUrl(camera, options.preview); return url ? { url, close: () => undefined } : null; }
  const path = (options.preview && camera.previewPath ? camera.previewPath : camera.rtspPath).replace(/^\/+/, "");
  if (!camera.secrets?.username || !camera.secrets.password || !path) return null;
  const target: TunnelTarget = { host: camera.host, port: camera.rtspPort, username: camera.secrets.username, password: camera.secrets.password, remember: `${camera.id}@${camera.host}:${camera.rtspPort}` };
  const word = randomBytes(18).toString("base64url");
  const sessions = new Set<Socket>();
  const maxSessions = options.maxSessions ?? 2;
  let admitted = 0;
  let closed = false;
  const server: Server = createServer();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    server.close();
    for (const socket of sessions) socket.destroy();
    sessions.clear();
  };
  const idle = setTimeout(() => { if (!admitted) close(); }, options.idleCloseMs ?? 20_000);
  idle.unref();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  const proxyBase = `rtsp://127.0.0.1:${port}/${word}`;
  const realBase = `rtsp://${camera.host.includes(":") ? `[${camera.host}]` : camera.host}:${camera.rtspPort}/${path}`;
  server.on("connection", client => {
    if (closed || admitted >= maxSessions || client.remoteAddress !== "127.0.0.1") { client.destroy(); return; }
    admitted += 1;
    sessions.add(client);
    client.once("close", () => sessions.delete(client));
    serveSession(client, target, proxyBase, realBase, ok => { if (!ok) admitted -= 1; });
    // Every session that FFmpeg could open is open: nobody else gets in afterwards.
    if (admitted >= maxSessions) server.close();
  });
  return { url: proxyBase, close };
}
