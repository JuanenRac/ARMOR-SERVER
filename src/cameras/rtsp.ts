/**
 * RTSP stream-path discovery: bounded, authenticated DESCRIBE requests that
 * never send a movement command and never put credentials in the request URI.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createConnection } from "node:net";
import { answerChallenge } from "./digest.js";
import { expandRtspPath, type CameraConnection } from "./model.js";

/** The paths that are tried, first the ones of the family the camera says it belongs to (see rtspFamily). `{user}` and `{password}` are where the login goes in the cameras that ask for it in the path. */
export const GENERIC_PATHS = ["/11", "/12", "/profile0", "/live", "/h264", "/stream1", "/stream2", "/Streaming/Channels/1", "/Streaming/Channels/101", "/Streaming/Channels/102", "/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1"];
/** H264DVR / XMeye cameras (a Sofia firmware sold under hundreds of names, often with two lenses): the login in the path, the lens as `channel`, the main or the lighter stream as `stream`. */
export const XM_PATHS = [
  "/user={user}&password={password}&channel=1&stream=0.sdp?real_stream", "/user={user}&password={password}&channel=1&stream=1.sdp?real_stream",
  "/user={user}_password={password}_channel=1_stream=0.sdp?real_stream", "/user={user}_password={password}_channel=1_stream=1.sdp?real_stream",
  "/user={user}&password={password}&channel=2&stream=0.sdp?real_stream", "/user={user}&password={password}&channel=2&stream=1.sdp?real_stream",
  "/ch0_0.264", "/ch0_1.264", "/ch1_0.264", "/onvif1", "/onvif2", "/av0_0", "/av0_1", "/stream0", "/live/ch00_0", "/live/ch00_1", "/1/h264major", "/1/h264minor", "/h264/ch1/main/av_stream", "/h264/ch1/sub/av_stream",
];
export const HIKVISION_PATHS = ["/Streaming/Channels/101", "/Streaming/Channels/102", "/Streaming/Channels/1", "/Streaming/Channels/201", "/Streaming/Channels/202", "/h264/ch1/main/av_stream", "/h264/ch1/sub/av_stream"];
export const DAHUA_PATHS = ["/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1", "/cam/realmonitor?channel=2&subtype=0", "/cam/realmonitor?channel=2&subtype=1"];
export type RtspFamily = "xm" | "hikvision" | "dahua" | "generic";
export const RTSP_PATH_CANDIDATES = GENERIC_PATHS;

/** The family a camera says it is in the `Server` header of its answer to OPTIONS (it needs no login), so the likely paths are tried first and the unlikely ones last. */
export function rtspFamily(banner: string): RtspFamily {
  if (/H264DVR|Sofia|XM|NVR|DVR/i.test(banner)) return "xm";
  if (/Hikvision|HIK|DNVRS|App-webs/i.test(banner)) return "hikvision";
  if (/Dahua|DH/i.test(banner)) return "dahua";
  return "generic";
}

/** The candidates for a family, its own first and then the rest of the generic ones, each once. */
export function candidatesFor(family: RtspFamily): string[] {
  const own = family === "xm" ? XM_PATHS : family === "hikvision" ? HIKVISION_PATHS : family === "dahua" ? DAHUA_PATHS : [];
  return [...new Set([...own, ...GENERIC_PATHS, ...XM_PATHS.slice(0, 4)])];
}

/** The `Server` header that the camera gives to an RTSP OPTIONS request, or an empty text when it gives none. */
export function rtspBanner(host: string, port: number, timeoutMs = 2_500): Promise<string> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let data = "";
    const done = () => { clearTimeout(timer); socket.destroy(); resolve(/^Server:\s*([^\r\n]+)/im.exec(data)?.[1]?.trim() ?? ""); };
    const timer = setTimeout(done, timeoutMs);
    socket.once("connect", () => socket.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\n\r\n`));
    socket.on("data", chunk => { data += chunk.toString("latin1"); if (data.includes("\r\n\r\n")) done(); });
    socket.once("error", () => { clearTimeout(timer); resolve(""); });
  });
}

/** The status code of an RTSP DESCRIBE, answering one Basic/Digest challenge if needed. */
export function rtspDescribe(camera: CameraConnection, requestPath: string, timeoutMs = 2_500): Promise<number> {
  return new Promise((resolve, reject) => {
    const credentials = camera.secrets;
    if (!credentials?.username || !credentials.password) { reject(new Error("missing RTSP credentials")); return; }
    // Several cameras reject a DESCRIBE URI that embeds userinfo, so the
    // credentials travel only in the Authorization header.
    const source = `rtsp://${camera.host}:${camera.rtspPort}/${expandRtspPath(requestPath, credentials).replace(/^\/+/, "")}`;
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
        const authorization = answerChallenge(challenge, credentials, "DESCRIBE", source, `${camera.id}@${camera.host}:${camera.rtspPort}`);
        if (authorization) { authenticated = true; data = ""; send(2, authorization); return; }
      }
      finish(status);
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}

/** Every candidate path that answers 200, in order; main and sub streams are not collapsed. */
export async function discoverRtspPaths(camera: CameraConnection, candidates?: readonly string[], pauseMs = 300, describe = rtspDescribe, banner = rtspBanner): Promise<string[]> {
  if (!camera.secrets?.username || !camera.secrets.password) return [];
  if (!candidates) candidates = candidatesFor(rtspFamily(await banner(camera.host, camera.rtspPort).catch(() => "")));
  const found: string[] = [];
  for (const candidate of candidates) {
    try { if (await describe(camera, candidate) === 200) found.push(candidate); } catch { /* Candidate unavailable. */ }
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return found;
}
