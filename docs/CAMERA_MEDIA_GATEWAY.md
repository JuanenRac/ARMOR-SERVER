# Camera media gateway

ARMOR-STUDIO and ARMOR-ANDROID-CONTROL never open an RTSP URL: browsers do not
play RTSP, and a camera password in a URL would end up in history, developer
tools and exports. Everything that touches a camera happens inside
ARMOR-SERVER; clients receive JSON, MJPEG and files only.

## Who may do what

| Action | Needs |
|---|---|
| List cameras (`camera-views`, no username) | nothing (local, read-only) |
| Configure, remove, discover, PTZ, snapshot, record, list/delete evidence | an operator: the Studio session cookie, an operator session or the operator token |
| Watch live video (`/cameras/:id/mjpeg`) | an operator **or** a stream ticket issued for that same camera |
| Get a stream ticket | an operator |

A ticket lasts five minutes, is bound to one camera and lets an `<img>` tag load
the stream without a header. Tickets and sessions are held in bounded tables.
Every denied attempt and every sensitive action is written to `data/audit.log`.

## Live video

With `ARMOR_FFMPEG_PATH` set, one FFmpeg process per active camera converts RTSP
to MJPEG (10 fps, 960 px wide) and every viewer of that camera shares it. The
relay closes five seconds after its last viewer leaves and the number of relays
is capped by `ARMOR_MAX_MJPEG_RELAYS`. Without FFmpeg the server answers `503`
instead of pretending video exists, and `409` when the RTSP path or a complete
credential pair is missing. The RTSP source is built in memory and never logged.

## Stream-path discovery

After a complete connection is saved, the operator can test a short list of
common RTSP paths with authenticated `DESCRIBE` requests. Credentials travel in
the `Authorization` header only (Basic, or Digest per RFC 7616), no movement
command is ever sent, and every path that answers `200` is reported so main and
sub streams are not collapsed. The RTSP path is vendor and profile specific;
discovery only tests known candidates.

## Network discovery

`POST /cameras/discover` probes the ordinary camera ports (80, 554, 8000, 8080,
8899) of one private IPv4 `/24`: the network of the server, or
`ARMOR_CAMERA_DISCOVERY_CIDR`. It sends no credentials, refuses public ranges,
runs one scan at a time (a second request answers `429`) and stops when the
client disconnects. The response names the networks it scanned.

## PTZ

`POST /cameras/:id/ptz` tries authenticated Hi3510 CGI, then PSIA, then ONVIF
Media/PTZ with a WS-Security password digest. Commands are an allow-list
(`left`, `right`, `up`, `down`, `zoomIn`, `zoomOut`, `stop`) and each movement is
short. A fixed camera, a wrong port or unsupported firmware returns an honest
failure, never a simulated movement. An ONVIF service address advertised by the
camera is accepted only when it stays on the configured camera host, and HTTP
redirects are refused, so a compromised camera cannot steer the server to
another machine.

## Credentials

Camera usernames and passwords are stored only in `data/cameras.json`, encrypted
with AES-256-GCM using `ARMOR_CAMERA_CONFIG_KEY` (a key separate from every
token), and the file is written atomically with mode `0600`. The operator list
shows the username so the form can be edited; **no API ever returns a
password**. Saving with an unchanged username and an empty password keeps the
stored one. A file written by an older release with the control-token key is
migrated once when the dedicated key is introduced; if the key is later lost,
the cameras stay listed without credentials and the server says so at startup.

## Evidence

Snapshots and recordings live under `data/media/<camera>/snapshots|recordings`.
A recording is accepted only when FFmpeg produced a non-empty MP4 and a
deliberate stop goes through FFmpeg's `q` command so the MP4 trailer is written.
Removing a camera never removes its footage; that is a separate action.

* **Retention:** oldest first once `ARMOR_MEDIA_MAX_BYTES` or
  `ARMOR_MEDIA_RETENTION_DAYS` is exceeded.
* **Protection:** `PUT .../protected` with `{"protected": true}` keeps a file out
  of automatic pruning, bulk deletion and single deletion until it is unprotected.
* **Chain of custody:** `GET .../sha256` returns the SHA-256 of the file as it
  is on disk. Record it next to the case; the file name and catalogue never
  contain credentials.
* The capture time is the file's modification time (evidence is never rewritten).

Define backup and access rules for `data/media/` before using it outside a
trusted network.

## Scale

For fleet-scale recording use a dedicated media service such as MediaMTX behind
the same boundary, and add WebRTC or HLS only after their access control and
retention are defined.
