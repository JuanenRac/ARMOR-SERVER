# Changelog

All notable changes to this project are documented here.

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
