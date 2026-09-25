# Changelog

All notable changes to this project are documented here.

## [0.5.0] - Working PTZ, manageable history

- **PTZ told the truth:** an empty 200 or a web page used to count as a confirmed move, so a camera without PTZ looked as if it moved. Now only a camera's own confirmation counts (`[Succeed]` from a Hi3510 unit, an XML status from PSIA), and a failed move says why: the stored login was refused, the camera did not answer, or it accepts no PTZ command. A refused login no longer waits for a slow ONVIF attempt.
- **PTZ stops itself:** most cameras keep turning until told to stop, so every move schedules its own stop after 2.5 s (a client holding a button repeats the move); closing the server cancels pending stops. PTZ has its own rate budget (240 a minute) and only the start of a movement is audited, not every repeat.
- **History:** search by node or camera, filter by level and by time range, read oldest first, `GET /api/v1/history/summary` (totals and the last 24 hours) and `DELETE /api/v1/history` (all events, one type, or older than N days) which needs `confirm=delete`, is permanent, audited, reaches the rotated log files and never reuses event numbers. The browsing window is now 5000 events.
- 118 tests (was 107).

## [0.4.0] - Camera watchdog, own broker, sharper security

- **Camera watchdog:** every configured camera is probed (a plain TCP connection to its RTSP or ONVIF port, no credential) every `ARMOR_CAMERA_CHECK_S` seconds (default 20, 0 disables). A camera is offline after two consecutive failures. Changes are events (`type: camera`), an offline camera is an alarm while armed (`camera.offline`), and `GET /api/v1/camera-status` (operator) reports each camera.
- **Security:** `GET /api/v1/status` now needs an operator (a stranger on the network could learn whether the system was armed and where the targets were); `GET /api/v1/info` shows the mode and capabilities only to an operator.
- **Security:** the answer to a field node's HTTP ingest is now just `accepted` and the revision; it used to return the whole perimeter state to whoever held the ingest token.
- **Security:** over MQTT a node can no longer speak for another one: the `node_id` in the body must be the node of the topic it was published on (the broker ACL guarantees who published it).
- **Security:** at most 256 distinct nodes are accepted, so inventing node names cannot grow the state and its file without bound; `DELETE /api/v1/nodes/:id` forgets a decommissioned node (operator, audited).
- The ingest rate budget is 6000 requests a minute (three nodes at 10 Hz need about 1800).
- Load and chaos tests (seeded fuzzing of both contracts and of the HTTP ingest, a 1000-message burst from 40 nodes, random operations against the state invariants, crash and restart cases, an unreachable webhook under a flood); 107 tests.

## [0.3.0] - State that survives, an event history and alarm output

- **Persistence:** the security mode and the last observation of every node are written atomically to `data/state.json` (the mode at once, node data coalesced) and restored at start. A restart no longer disarms the perimeter; restored nodes are stale until they speak again. A damaged or foreign file is ignored, never trusted.
- **Event history:** every alert-level change, node status change (online, offline, silent) and mode change is recorded in `data/events.log` (rotated) and served, newest first and paged, by `GET /api/v1/history` (operator).
- **Alarm output:** `alert.raised`, `alert.cleared` and, while armed, `node.offline` / `node.stale` are published on MQTT `armor/server/alert` and POSTed to an optional webhook (`ARMOR_ALERT_WEBHOOK_URL`), signed with `X-Armor-Signature: sha256=HMAC` when `ARMOR_ALERT_WEBHOOK_SECRET` is set. Delivery never blocks ingestion, retries server errors with back-off, does not retry client errors, follows no redirect and is audited.
- **Alert rules:** `ARMOR_ALERT_DWELL_MS` (default 2000) is how long two targets must persist before the alert becomes high, and rectangular ignore zones (per node and sensor) exclude targets such as a road. `GET`/`PUT /api/v1/rules` are strictly validated, persisted in `data/rules.json` and audited.
- A time-driven sweep (every 2 s) makes silence and dwell time take effect without a message.
- Ingest has its own rate budget (1200/min) so a burst of node messages cannot lock an operator out.
- Removed the leftover Python server (`http_api.py`, `service.py`, `state.py`) and its tests; the end-to-end check now runs the real simulator against the real server.
- 91 tests (was 75).

## [0.2.0] - Modular server, security fixes and honest node state

- Split the 700-line `server.ts` into `config`, `http/auth`, `context`, `app`, `routes/*`, `cameras/*` and `media/*`; the behaviour of every existing route is unchanged.
- **Security:** `GET /cameras/:id/mjpeg` no longer streams to an anonymous caller (it needs an operator or a ticket issued for that camera) and `POST .../stream-ticket` now needs an operator; the ticket used to be issued to anyone and never checked.
- **Security:** bearer tokens are compared in constant time everywhere; sessions and stream tickets are capped in number; malformed requests get a plain error instead of a stack trace; tokens must be at least 24 characters.
- **Security:** one camera discovery at a time (a second request answers 429) and it stops when the client disconnects; discovery only accepts private networks.
- HTTP and RTSP Digest authentication now follows RFC 7616 (qop=auth, cnonce, nonce count, SHA-256), verified against the RFC 2617 worked example.
- Added an audit trail (`data/audit.log`, JSON lines, rotated, credentials scrubbed).
- Evidence: protection from automatic pruning, a `sha256` endpoint for chain of custody, asynchronous catalogue listing, and the capture time now comes from the modification time on every filesystem.
- Nodes that stop reporting are shown as stale and offline; disarming clears high alerts immediately; added `GET /api/v1/info`.
- WebSocket events also accept an operator session cookie; `ARMOR_HOST` selects the listen address (loopback by default); graceful shutdown on SIGTERM and SIGINT.
- 70 tests, including a full HTTP integration suite against an isolated server (previously 3).

## [0.1.3] - 2026-09-21

- Verified build completed; release version advanced from `0.1.2` to `0.1.3`.

## [0.1.2] - 2026-09-21

- Verified build completed; release version advanced from `0.1.1` to `0.1.2`.

## [0.1.1] - 2026-09-21

- Verified build completed; release version advanced from `0.1.0` to `0.1.1`.
- Fixed the standardized launcher so ignored local `.env` tokens reach the Node runtime even when an inherited shell variable is empty or a placeholder.
- Added loopback-only local camera-service discovery and accepted both local Studio origins (`127.0.0.1` and `localhost`) through CORS.
- Earlier work: Studio login endpoint with a dedicated HttpOnly session, real Hi3510/PSIA/ONVIF PTZ, JPEG snapshots and MP4 recordings, an evidence catalogue, RTSP path discovery and AES-256-GCM encrypted camera credentials.
