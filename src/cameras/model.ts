/**
 * A.R.M.O.R. camera model: the stored connection, its public projections and
 * strict validation of operator input.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type CameraSecrets = { username: string; password: string };

export type CameraConnection = {
  id: string; name: string; host: string; snapshotUrl: string; rtspPath: string;
  /** A lighter stream of the same camera (its sub-stream) for the live picture in the console, when it has one; empty: the live picture uses `rtspPath`. */
  previewPath?: string;
  onvifPort: number; rtspPort: number; secrets?: CameraSecrets;
} & CameraTraits;

/**
 * What a camera is, beyond how to reach it. A camera with several lenses is stored as one camera per lens (each with its own stream and its own movement), tied by `group`; a camera
 * whose single stream carries two lenses one above the other has `layout: "split"` and the console shows it in two windows. Every field is optional: a camera saved before has none.
 */
export type CameraTraits = {
  /** "split": the stream is two lenses, one on top of the other, shown as two windows. */
  layout?: "single" | "split";
  /** The cameras that are the lenses of one body share this identifier; `lensName` says which lens this one is. */
  group?: string; lensName?: string;
  /** The type of camera chosen in the form (informative; the fields below are what counts). */
  preset?: string;
  /** Whether the lens turns (pan and tilt) and whether it zooms: the movement buttons of the console follow these. */
  ptz?: boolean; zoom?: boolean;
  /** The web page of the camera's own configurator, opened from a button. */
  webUrl?: string;
  /** Field of view of the lens at rest, how far the motor sweeps (pan, tilt) and how far it sees, for the site designer. */
  fovDeg?: number; panRangeDeg?: number; tiltRangeDeg?: number; rangeM?: number;
  /** Internal parameters of the camera that the operator wants noted: network and encoder. */
  params?: CameraParams;
};
export type CameraParams = { wifiSsid?: string; ip?: string; encoder?: string; bitrateKbps?: number; resolution?: string };
/** What an authorised operator sees: everything except the password. */
export type PublicCamera = Omit<CameraConnection, "secrets"> & { username: string; hasCredentials: boolean; liveVideoAvailable: boolean };
/** What any local viewer sees: no username and no credentials at all. */
export type CameraView = Omit<PublicCamera, "username">;

export const CAMERA_ID = /^[A-Za-z0-9._-]{3,80}$/;

/**
 * On many cheap cameras the address of the snapshot carries the login (http://user:pass@cam/snapshot.cgi, or ?user=...&pwd=...). The server never uses that address for anything, and
 * what it stored in clear was handed to every viewer and written in the installation file. The login of a camera belongs in its credentials (the encrypted ones); an address
 * that carries one is refused, and one stored before is shown with the login hidden.
 */
const LOGIN_PARAMETER = /([?&](?:user|username|usr|login|pass|passwd|password|pwd|token|key|secret|auth)=)[^&\s]*/gi;
export const hideSnapshotLogin = (url: string): string => url.replace(/(:\/\/)[^\/\s@]*@/, "$1***@").replace(LOGIN_PARAMETER, "$1***");
const snapshotHasLogin = (url: string): boolean => hideSnapshotLogin(url) !== url;
const HOSTNAME = /^[A-Za-z0-9.-]+$/;

export const validPort = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;

export function cameraPublic(camera: CameraConnection, ffmpegConfigured: boolean): PublicCamera {
  const { secrets, ...rest } = camera;
  const hasCredentials = Boolean(secrets?.username && secrets.password);
  return { ...rest, snapshotUrl: hideSnapshotLogin(rest.snapshotUrl), username: secrets?.username ?? "", hasCredentials, liveVideoAvailable: Boolean(ffmpegConfigured && hasCredentials && camera.rtspPath) };
}

export function cameraView(camera: CameraConnection, ffmpegConfigured: boolean): CameraView {
  const { username: _username, ...view } = cameraPublic(camera, ffmpegConfigured);
  return view;
}

/**
 * Validate an operator's camera form. Studio shows the stored username but
 * masks the password, so editing any other field sends a username with an
 * empty password: that keeps the existing credential pair. A changed username
 * needs a replacement password. Returns null for anything invalid.
 */
export function parseCameraInput(body: unknown, existing?: CameraConnection): CameraConnection | null {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  const text = (key: string) => typeof input[key] === "string" ? (input[key] as string).trim() : "";
  const id = text("id"), name = text("name"), host = text("host");
  if (!CAMERA_ID.test(id) || !name || !host || host.length > 253 || !HOSTNAME.test(host)) return null;
  const username = text("username"), password = text("password");
  const stored = existing?.secrets;
  const secrets: CameraSecrets | undefined =
    username && password ? { username, password }
      : !username && !password ? stored
        : username && !password && stored?.username === username ? stored
          : !username && password && stored?.username ? { username: stored.username, password }
            : undefined;
  if ((username || password) && !secrets) return null;
  if (username.length > 128 || password.length > 256) return null;
  // The form shows the address with its login hidden: sent back untouched, it means "keep what is stored"; a new address that carries a login is refused.
  let snapshotUrl = text("snapshotUrl").slice(0, 500);
  if (snapshotUrl.includes("***")) snapshotUrl = existing && hideSnapshotLogin(existing.snapshotUrl) === snapshotUrl ? existing.snapshotUrl : "";
  else if (snapshotHasLogin(snapshotUrl)) return null;
  return {
    id, name: name.slice(0, 80), host, snapshotUrl,
    rtspPath: text("rtspPath").replace(/^\/+/, "").slice(0, 500),
    previewPath: text("previewPath").replace(/^\/+/, "").slice(0, 500),
    onvifPort: validPort(input.onvifPort, 80), rtspPort: validPort(input.rtspPort, 554),
    secrets,
    ...parseTraits(input),
  };
}

const number = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 10) / 10 : undefined;
const short = (value: unknown, max = 80): string => typeof value === "string" ? value.trim().slice(0, max) : "";

/** A web address for the configurator button: http or https, no login inside. */
export function parseWebUrl(value: unknown): string {
  const raw = short(value, 300);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
}

/** The optional traits of a camera; a wrong value is dropped, never an error, so an older Studio keeps working. */
export function parseTraits(input: Record<string, unknown>): CameraTraits {
  const traits: CameraTraits = {};
  if (input.layout === "single" || input.layout === "split") traits.layout = input.layout;
  const group = short(input.group, 80);
  if (CAMERA_ID.test(group)) traits.group = group;
  const lensName = short(input.lensName, 40);
  if (lensName) traits.lensName = lensName;
  const preset = short(input.preset, 40);
  if (/^[a-z0-9_-]+$/.test(preset)) traits.preset = preset;
  if (typeof input.ptz === "boolean") traits.ptz = input.ptz;
  if (typeof input.zoom === "boolean") traits.zoom = input.zoom;
  const webUrl = parseWebUrl(input.webUrl);
  if (webUrl) traits.webUrl = webUrl;
  const fov = number(input.fovDeg, 1, 360), pan = number(input.panRangeDeg, 0, 360), tilt = number(input.tiltRangeDeg, 0, 180), range = number(input.rangeM, 1, 500);
  if (fov !== undefined) traits.fovDeg = fov;
  if (pan !== undefined) traits.panRangeDeg = pan;
  if (tilt !== undefined) traits.tiltRangeDeg = tilt;
  if (range !== undefined) traits.rangeM = range;
  const raw = input.params;
  if (raw && typeof raw === "object") {
    const p = raw as Record<string, unknown>, params: CameraParams = {};
    const wifiSsid = short(p.wifiSsid, 32), ip = short(p.ip, 45), encoder = short(p.encoder, 20), resolution = short(p.resolution, 20);
    const bitrate = number(p.bitrateKbps, 16, 100000);
    if (wifiSsid) params.wifiSsid = wifiSsid;
    if (/^[0-9A-Fa-f:.]+$/.test(ip)) params.ip = ip;
    if (encoder) params.encoder = encoder;
    if (resolution) params.resolution = resolution;
    if (bitrate !== undefined) params.bitrateKbps = bitrate;
    if (Object.keys(params).length) traits.params = params;
  }
  return traits;
}

/** The RTSP source URL, built only in memory when it is needed. `preview` asks for the lighter stream of the live picture when the camera has one. */
export function rtspUrl(camera: CameraConnection, preview = false): string | null {
  const path = preview && camera.previewPath ? camera.previewPath : camera.rtspPath;
  if (!camera.secrets?.username || !camera.secrets.password || !path) return null;
  const user = encodeURIComponent(camera.secrets.username);
  const password = encodeURIComponent(camera.secrets.password);
  return `rtsp://${user}:${password}@${camera.host}:${camera.rtspPort}/${path.replace(/^\/+/, "")}`;
}
