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

/** The paths of a family, and the generic ones that are tried after them (each once). */
export function candidateGroups(family: RtspFamily): { own: string[]; rest: string[] } {
  const own = family === "xm" ? XM_PATHS : family === "hikvision" ? HIKVISION_PATHS : family === "dahua" ? DAHUA_PATHS : [];
  return { own: [...own], rest: [...new Set([...GENERIC_PATHS, ...XM_PATHS.slice(0, 4)])].filter(path => !own.includes(path)) };
}

/** The candidates for a family, its own first and then the rest of the generic ones, each once. */
export function candidatesFor(family: RtspFamily): string[] {
  const { own, rest } = candidateGroups(family);
  return [...own, ...rest];
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

/**
 * Asks DESCRIBE for many paths over ONE connection: a camera on Wi-Fi takes a second to open each connection and cheap ones allow very few at a time, so the search
 * that opened one connection per path took a minute and lost answers. The first answer carries the Digest challenge; the following requests answer it again with their own path.
 * Returns the status of each path (0 for the ones that got no answer).
 */
export function rtspDescribeMany(camera: CameraConnection, paths: readonly string[], perRequestMs = 5_000): Promise<Map<string, number>> {
  return new Promise(resolve => {
    const credentials = camera.secrets;
    const result = new Map<string, number>();
    if (!credentials?.username || !credentials.password || paths.length === 0) { resolve(result); return; }
    const socket = createConnection({ host: camera.host, port: camera.rtspPort });
    let buffer = "", index = 0, sequence = 1, challenge: string | undefined, retried = false, timer: NodeJS.Timeout | undefined;
    const sourceOf = (path: string) => `rtsp://${camera.host}:${camera.rtspPort}/${expandRtspPath(path, credentials).replace(/^\/+/, "")}`;
    const finish = () => { if (timer) clearTimeout(timer); socket.destroy(); resolve(result); };
    const next = () => {
      if (index >= paths.length) { finish(); return; }
      const source = sourceOf(paths[index]);
      const authorization = challenge ? answerChallenge(challenge, credentials, "DESCRIBE", source) : null;
      socket.write(`DESCRIBE ${source} RTSP/1.0\r\nCSeq: ${sequence++}\r\nAccept: application/sdp\r\n${authorization ? `Authorization: ${authorization}\r\n` : ""}\r\n`);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { result.set(paths[index], 0); finish(); }, perRequestMs);
    };
    socket.once("connect", next);
    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.slice(0, end);
      const length = Number(/^Content-Length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
      if (buffer.length < end + 4 + length) return;   // the body of the answer (the SDP) is still on its way
      buffer = buffer.slice(end + 4 + length);
      const status = Number(/^RTSP\/1\.0 (\d{3})/.exec(head)?.[1] ?? 0);
      if (status === 401) {
        const header = /WWW-Authenticate:\s*([^\r\n]+)/i.exec(head)?.[1];
        if (header && !retried) { challenge = header; retried = true; next(); return; }   // the challenge of the camera: ask the same path again, now with the answer
      }
      retried = false;
      result.set(paths[index], status);
      index += 1;
      next();
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
  });
}

/**
 * Every candidate path that answers 200, in order; main and sub streams are not collapsed. When the camera says which family it is, only the paths of that family are tried
 * if any of them answers: a camera on Wi-Fi takes a second or two for each one, and the generic paths would only make the search last a minute for nothing.
 */
export async function discoverRtspPaths(camera: CameraConnection, candidates?: readonly string[], pauseMs = 100, describe = rtspDescribe, banner = rtspBanner): Promise<string[]> {
  if (!camera.secrets?.username || !camera.secrets.password) return [];
  let groups: string[][];
  if (candidates) groups = [[...candidates]];
  else {
    const { own, rest } = candidateGroups(rtspFamily(await banner(camera.host, camera.rtspPort).catch(() => "")));
    groups = [own, rest];
  }
  const found: string[] = [];
  for (const group of groups) {
    if (describe === rtspDescribe) {
      const answers = await rtspDescribeMany(camera, group);
      for (const path of group) if (answers.get(path) === 200) found.push(path);
    } else {
      for (const candidate of group) {
        try { if (await describe(camera, candidate, 4_000) === 200) found.push(candidate); } catch { /* Candidate unavailable. */ }
        if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
    }
    if (found.length > 0) break;   // the first group that answers is the camera's: no need to go on with the others
  }
  return found;
}
