# Changelog

All notable changes to this project are documented here.

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
