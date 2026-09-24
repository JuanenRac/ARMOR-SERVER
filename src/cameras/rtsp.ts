/**
 * RTSP stream-path discovery: bounded, authenticated DESCRIBE requests that
 * never send a movement command and never put credentials in the request URI.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createConnection } from "node:net";
import { answerChallenge } from "./digest.js";
import type { CameraConnection } from "./model.js";

export const RTSP_PATH_CANDIDATES = ["/11", "/12", "/profile0", "/live", "/h264", "/stream1", "/Streaming/Channels/1", "/cam/realmonitor?channel=1&subtype=0"];

/** The status code of an RTSP DESCRIBE, answering one Basic/Digest challenge if needed. */
export function rtspDescribe(camera: CameraConnection, requestPath: string, timeoutMs = 2_500): Promise<number> {
  return new Promise((resolve, reject) => {
    const credentials = camera.secrets;
    if (!credentials?.username || !credentials.password) { reject(new Error("missing RTSP credentials")); return; }
    // Several cameras reject a DESCRIBE URI that embeds userinfo, so the
    // credentials travel only in the Authorization header.
    const source = `rtsp://${camera.host}:${camera.rtspPort}/${requestPath.replace(/^\/+/, "")}`;
    const socket = createConnection({ host: camera.host, port: camera.rtspPort });
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("RTSP timeout")); }, timeoutMs);
    let authenticated = false;
    let data = "";
    const finish = (status: number) => { clearTimeout(timeout); socket.destroy(); resolve(status); };
    const send = (sequence: number, authorization?: string) =>
      socket.write(`DESCRIBE ${source} RTSP/1.0\r\nCSeq: ${sequence}\r\nAccept: application/sdp\r\n${authorization ? `Authorization: ${authorization}\r\n` : ""}\r\n`);
    socket.once("connect", () => send(1));
    socket.on("data", chunk => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      const status = Number(/^RTSP\/1\.0 (\d{3})/.exec(data)?.[1] ?? 0);
      if (!authenticated && status === 401) {
        const challenge = /WWW-Authenticate:\s*([^\r\n]+)/i.exec(data)?.[1];
        const authorization = answerChallenge(challenge, credentials, "DESCRIBE", source);
        if (authorization) { authenticated = true; data = ""; send(2, authorization); return; }
      }
      finish(status);
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}

/** Every candidate path that answers 200, in order; main and sub streams are not collapsed. */
export async function discoverRtspPaths(camera: CameraConnection, candidates: readonly string[] = RTSP_PATH_CANDIDATES, pauseMs = 300, describe = rtspDescribe): Promise<string[]> {
  if (!camera.secrets?.username || !camera.secrets.password) return [];
  const found: string[] = [];
  for (const candidate of candidates) {
    try { if (await describe(camera, candidate) === 200) found.push(candidate); } catch { /* Candidate unavailable. */ }
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return found;
}
