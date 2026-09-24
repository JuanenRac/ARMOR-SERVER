/**
 * A.R.M.O.R. camera model: the stored connection, its public projections and
 * strict validation of operator input.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type CameraSecrets = { username: string; password: string };

export type CameraConnection = {
  id: string; name: string; host: string; snapshotUrl: string; rtspPath: string;
  onvifPort: number; rtspPort: number; secrets?: CameraSecrets;
};
/** What an authorised operator sees: everything except the password. */
export type PublicCamera = Omit<CameraConnection, "secrets"> & { username: string; hasCredentials: boolean; liveVideoAvailable: boolean };
/** What any local viewer sees: no username and no credentials at all. */
export type CameraView = Omit<PublicCamera, "username">;

export const CAMERA_ID = /^[A-Za-z0-9._-]{3,80}$/;
const HOSTNAME = /^[A-Za-z0-9.-]+$/;

export const validPort = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;

export function cameraPublic(camera: CameraConnection, ffmpegConfigured: boolean): PublicCamera {
  const { secrets, ...rest } = camera;
  const hasCredentials = Boolean(secrets?.username && secrets.password);
  return { ...rest, username: secrets?.username ?? "", hasCredentials, liveVideoAvailable: Boolean(ffmpegConfigured && hasCredentials && camera.rtspPath) };
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
  return {
    id, name: name.slice(0, 80), host, snapshotUrl: text("snapshotUrl").slice(0, 500),
    rtspPath: text("rtspPath").replace(/^\/+/, "").slice(0, 500),
    onvifPort: validPort(input.onvifPort, 80), rtspPort: validPort(input.rtspPort, 554),
    secrets,
  };
}

/** The RTSP source URL, built only in memory when it is needed. */
export function rtspUrl(camera: CameraConnection): string | null {
  if (!camera.secrets?.username || !camera.secrets.password || !camera.rtspPath) return null;
  const user = encodeURIComponent(camera.secrets.username);
  const password = encodeURIComponent(camera.secrets.password);
  return `rtsp://${user}:${password}@${camera.host}:${camera.rtspPort}/${camera.rtspPath.replace(/^\/+/, "")}`;
}
