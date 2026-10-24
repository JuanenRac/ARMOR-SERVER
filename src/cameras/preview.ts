/**
 * The still picture a camera gives at its snapshot address, fetched by the server with the camera's own login so that a console never needs
 * (or sees) that login: the address stored for the camera carries none.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { answerChallenge } from "./digest.js";
import { mediaError } from "./errors.js";
import type { CameraConnection } from "./model.js";

export type CameraPicture = { contentType: string; body: Buffer };

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = /^image\/(jpeg|png)\b/i;
const normalize = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

/** The address the picture is asked from: http or https, no login inside, and on the camera's own host, so a stored address cannot steer the server to another machine. */
export function previewTarget(camera: Pick<CameraConnection, "host" | "snapshotUrl">): URL {
  let url: URL;
  try { url = new URL(camera.snapshotUrl); } catch { throw mediaError("the camera has no valid snapshot address"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw mediaError("the camera has no valid snapshot address");
  if (url.username || url.password) throw mediaError("the snapshot address must not carry a login");
  if (normalize(url.hostname) !== normalize(camera.host)) throw mediaError("the snapshot address is not on the camera's host");
  return url;
}

function once(url: URL, authorization: string | undefined, timeoutMs: number): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: "GET", headers: { Accept: "image/jpeg,image/png", ...(authorization ? { Authorization: authorization } : {}) }, timeout: timeoutMs }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { request.destroy(); reject(mediaError("the camera picture is too large")); return; }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({ response, body: Buffer.concat(chunks) }));
      response.once("error", () => reject(mediaError("the camera is unavailable")));
    });
    request.once("error", () => reject(mediaError("the camera is unavailable")));
    request.once("timeout", () => { request.destroy(); reject(mediaError("the camera is unavailable")); });
    request.end();
  });
}

/** Asks the camera for its snapshot (Basic or Digest login from the camera's credentials), without following redirects, and checks that an image came back. */
export async function fetchCameraPicture(camera: CameraConnection, timeoutMs = 5_000): Promise<CameraPicture> {
  const url = previewTarget(camera);
  let { response, body } = await once(url, undefined, timeoutMs);
  if (response.statusCode === 401 && camera.secrets?.username && camera.secrets.password) {
    const header = response.headers["www-authenticate"];
    const answer = answerChallenge(Array.isArray(header) ? header[0] : header, camera.secrets, "GET", url.pathname + url.search, `${camera.id}@${camera.host}:preview`);
    if (answer) ({ response, body } = await once(url, answer, timeoutMs));
  }
  if (response.statusCode === 401 || response.statusCode === 403) throw mediaError("the camera refused the login");
  if (response.statusCode !== 200) throw mediaError("the camera gave no picture");
  const type = String(response.headers["content-type"] ?? "");
  if (!TYPES.test(type) || body.length === 0) throw mediaError("the camera did not answer with a picture");
  return { contentType: type.split(";")[0].trim().toLowerCase(), body };
}
