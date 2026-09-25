/**
 * Camera PTZ control: authenticated Hi3510 CGI and PSIA first, then ONVIF
 * Media/PTZ with a WS-Security password digest. Every movement is short and
 * bounded, and a camera can only answer for its own configured host.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { answerChallenge } from "./digest.js";
import { mediaError } from "./errors.js";
import type { CameraConnection } from "./model.js";

export const PTZ_COMMANDS = ["left", "right", "up", "down", "zoomIn", "zoomOut", "stop"] as const;
export type PtzCommand = (typeof PTZ_COMMANDS)[number];
export const isPtzCommand = (value: unknown): value is PtzCommand => typeof value === "string" && (PTZ_COMMANDS as readonly string[]).includes(value);

const ONVIF_VECTORS: Record<PtzCommand, { pan?: number; tilt?: number; zoom?: number }> = {
  left: { pan: -0.45 }, right: { pan: 0.45 }, up: { tilt: 0.45 }, down: { tilt: -0.45 }, zoomIn: { zoom: 0.35 }, zoomOut: { zoom: -0.35 }, stop: {},
};
const LEGACY_VECTORS: Record<PtzCommand, { action: string; pan: number; tilt: number; zoom: number }> = {
  left: { action: "left", pan: -55, tilt: 0, zoom: 0 }, right: { action: "right", pan: 55, tilt: 0, zoom: 0 },
  up: { action: "up", pan: 0, tilt: 55, zoom: 0 }, down: { action: "down", pan: 0, tilt: -55, zoom: 0 },
  zoomIn: { action: "zoomin", pan: 0, tilt: 0, zoom: 55 }, zoomOut: { action: "zoomout", pan: 0, tilt: 0, zoom: -55 },
  stop: { action: "stop", pan: 0, tilt: 0, zoom: 0 },
};

export const xmlEscape = (value: string): string => value.replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character] ?? character);
export const xmlUnescape = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);

/**
 * An ONVIF service address advertised by a camera is only accepted when it
 * stays on the configured host, so a compromised camera cannot steer this
 * server to another machine on the network.
 */
export function approvedCameraEndpoint(camera: Pick<CameraConnection, "host">, endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw mediaError("camera returned an invalid ONVIF endpoint"); }
  const normalize = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || normalize(url.hostname) !== normalize(camera.host)) {
    throw mediaError("camera returned an ONVIF endpoint outside its configured host");
  }
  return url.toString();
}

function onvifEnvelope(camera: CameraConnection, body: string): string {
  if (!camera.secrets?.username || !camera.secrets.password) throw mediaError("complete camera credentials are required");
  const rawNonce = randomBytes(16);
  const created = new Date().toISOString();
  const digest = createHash("sha1").update(Buffer.concat([rawNonce, Buffer.from(created), Buffer.from(camera.secrets.password)])).digest("base64");
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><s:Header><wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${xmlEscape(camera.secrets.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${rawNonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}

async function onvifPost(camera: CameraConnection, endpoint: string, action: string, body: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch(approvedCameraEndpoint(camera, endpoint), {
      method: "POST", signal: controller.signal, redirect: "error",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8", SOAPAction: action }, body: onvifEnvelope(camera, body),
    });
    const xml = await response.text();
    if (!response.ok || /<(?:\w+:)?Fault\b/i.test(xml)) throw mediaError("camera rejected the ONVIF operation");
    return xml;
  } catch (error) {
    if (error instanceof Error && error.name === "MediaError") throw error;
    throw mediaError("camera ONVIF service is unavailable");
  } finally { clearTimeout(timeout); }
}

export function onvifTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:(?:\\w+):)?${tag}[^>]*>\\s*([^<]+)`, "i").exec(xml);
  return match?.[1] ? xmlUnescape(match[1].trim()) : null;
}

async function onvifProfile(camera: CameraConnection): Promise<{ endpoint: string; token: string }> {
  const deviceEndpoint = `http://${camera.host}:${camera.onvifPort}/onvif/device_service`;
  const capabilities = await onvifPost(camera, deviceEndpoint, "http://www.onvif.org/ver10/device/wsdl/GetCapabilities", '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>');
  const media = onvifTag(/<(?:\w+:)?Media\b[\s\S]*?<\/(?:\w+:)?Media>/i.exec(capabilities)?.[0] ?? "", "XAddr");
  const ptz = onvifTag(/<(?:\w+:)?PTZ\b[\s\S]*?<\/(?:\w+:)?PTZ>/i.exec(capabilities)?.[0] ?? "", "XAddr");
  if (!media || !ptz) throw mediaError("camera does not advertise ONVIF media and PTZ services");
  const profiles = await onvifPost(camera, media, "http://www.onvif.org/ver10/media/wsdl/GetProfiles", '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>');
  const token = /<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"/i.exec(profiles)?.[1];
  if (!token) throw mediaError("camera did not expose an ONVIF media profile");
  return { endpoint: approvedCameraEndpoint(camera, ptz), token: xmlUnescape(token) };
}

async function onvifMove(camera: CameraConnection, command: PtzCommand): Promise<void> {
  const profile = await onvifProfile(camera);
  if (command === "stop") {
    await onvifPost(camera, profile.endpoint, "http://www.onvif.org/ver20/ptz/wsdl/Stop", `<tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"><tptz:ProfileToken>${xmlEscape(profile.token)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
    return;
  }
  const vector = ONVIF_VECTORS[command];
  const panTilt = vector.pan !== undefined || vector.tilt !== undefined ? `<tt:PanTilt x="${vector.pan ?? 0}" y="${vector.tilt ?? 0}"/>` : "";
  const zoom = vector.zoom !== undefined ? `<tt:Zoom x="${vector.zoom}"/>` : "";
  await onvifPost(camera, profile.endpoint, "http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove", `<tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><tptz:ProfileToken>${xmlEscape(profile.token)}</tptz:ProfileToken><tptz:Velocity>${panTilt}${zoom}</tptz:Velocity><tptz:Timeout>PT0.35S</tptz:Timeout></tptz:ContinuousMove>`);
}

type HttpResult = { status: number; body: string };

/** One authenticated request to the camera's own HTTP interface (Basic or Digest). */
function cameraHttp(camera: CameraConnection, method: string, requestPath: string, body?: string): Promise<HttpResult> {
  return new Promise(resolve => {
    const credentials = camera.secrets;
    if (!credentials?.username || !credentials.password) { resolve({ status: 401, body: "" }); return; }
    const execute = (authorization?: string): void => {
      const headers: Record<string, string> = {
        ...(body ? { "Content-Type": "application/xml", "Content-Length": String(Buffer.byteLength(body)) } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      };
      const request = httpRequest({ host: camera.host, port: camera.onvifPort, method, path: requestPath, headers, timeout: 4_000 }, response => {
        let payload = "";
        response.on("data", chunk => { if (payload.length < 8192) payload += chunk.toString("utf8"); });
        response.on("end", () => {
          if (response.statusCode === 401 && !authorization) {
            const header = response.headers["www-authenticate"];
            const answer = answerChallenge(Array.isArray(header) ? header[0] : header, credentials, method, requestPath);
            if (answer) { execute(answer); return; }
          }
          resolve({ status: response.statusCode ?? 0, body: payload });
        });
      });
      request.once("error", () => resolve({ status: 0, body: "" }));
      request.once("timeout", () => { request.destroy(); resolve({ status: 0, body: "" }); });
      if (body) request.write(body);
      request.end();
    };
    execute();
  });
}

export type LegacyOutcome = "ok" | "unauthorized" | "unreachable" | "unsupported";

/**
 * A camera confirms a command in its own words: a Hi3510 unit answers `[Succeed]set ok.`, a PSIA or
 * ISAPI unit an XML status. An empty 200 (some cameras answer every unknown address that way) or a
 * web page is NOT a confirmation: counting it as one made a camera without PTZ look as if it moved.
 */
export const hi3510Confirmed = (result: HttpResult): boolean => result.status >= 200 && result.status < 300 && /\[Succeed\]/i.test(result.body);
export const psiaConfirmed = (result: HttpResult): boolean =>
  result.status >= 200 && result.status < 300 && /<statusCode>\s*1\s*<\/statusCode>|<statusString>\s*OK\s*<\/statusString>/i.test(result.body);

async function legacyMove(camera: CameraConnection, command: PtzCommand): Promise<LegacyOutcome> {
  const vector = LEGACY_VECTORS[command];
  const hi3510 = await cameraHttp(camera, "GET", `/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=${encodeURIComponent(vector.action)}&-speed=38`);
  if (hi3510Confirmed(hi3510)) return "ok";
  const psia = await cameraHttp(camera, "PUT", "/PSIA/PTZ/channels/1/continuous", `<PTZData version="1.0" xmlns="urn:psialliance-org"><pan>${vector.pan}</pan><tilt>${vector.tilt}</tilt><zoom>${vector.zoom}</zoom></PTZData>`);
  if (psiaConfirmed(psia)) return "ok";
  if (hi3510.status === 0 && psia.status === 0) return "unreachable";
  if (hi3510.status === 401 || hi3510.status === 403 || psia.status === 401 || psia.status === 403) return "unauthorized";
  return "unsupported";
}

/**
 * Move the camera: Hi3510 / PSIA first, then ONVIF, and say honestly why it failed: the stored
 * login was refused, the camera did not answer, or it accepts no PTZ command at all.
 */
export async function movePtz(camera: CameraConnection, command: unknown): Promise<void> {
  if (!isPtzCommand(command)) throw mediaError("invalid PTZ command");
  const outcome = await legacyMove(camera, command);
  if (outcome === "ok") return;
  if (outcome === "unauthorized") throw mediaError("the camera refused the stored login: check its web password in the camera settings");
  if (outcome === "unreachable") throw mediaError("the camera did not answer on its web port");
  try { await onvifMove(camera, command); }
  catch { throw mediaError("this camera accepts no PTZ command (Hi3510, PSIA and ONVIF were all refused); it may not have PTZ hardware"); }
}

/**
 * Moves are continuous on most cameras (they keep turning until told to stop), so a lost "stop" -
 * a closed tab, a dropped connection - would leave the camera turning against its end stop. Every
 * move therefore schedules its own stop, and a client that is still holding a button repeats the move.
 */
export class PtzController {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #maxMoveMs: number;
  readonly #move: (camera: CameraConnection, command: unknown) => Promise<void>;

  constructor(options: { maxMoveMs?: number; move?: (camera: CameraConnection, command: unknown) => Promise<void> } = {}) {
    this.#maxMoveMs = options.maxMoveMs ?? 2_500;
    this.#move = options.move ?? movePtz;
  }

  async move(camera: CameraConnection, command: unknown): Promise<void> {
    await this.#move(camera, command);
    const pending = this.#timers.get(camera.id);
    if (pending) clearTimeout(pending);
    this.#timers.delete(camera.id);
    if (command === "stop") return;
    const timer = setTimeout(() => { this.#timers.delete(camera.id); void this.#move(camera, "stop").catch(() => undefined); }, this.#maxMoveMs);
    timer.unref();
    this.#timers.set(camera.id, timer);
  }

  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
