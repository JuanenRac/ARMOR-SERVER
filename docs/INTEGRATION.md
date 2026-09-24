# First vertical integration

1. Generate JSONL with `ARMOR-SIMULATOR` (`--server-url` and `--ingest-token` deliver it over HTTP).
2. Validate every envelope with `ARMOR-COMMON` (`--validate`); the server validates again at its boundary.
3. Read the state from `GET /api/v1/status` and the changes from `GET /api/v1/history`.

`tests/vertical-slice.test.ts` runs exactly this path with the real simulator and the real server.
The Node service provides `GET /healthz` and `GET /api/v1/status`. It accepts no
unauthenticated writes.

Alarms leave the server on MQTT `armor/server/alert` and, when `ARMOR_ALERT_WEBHOOK_URL` is set, as a
JSON POST. When `ARMOR_ALERT_WEBHOOK_SECRET` is set the body is signed: check
`X-Armor-Signature: sha256=<hex HMAC-SHA256 of the raw body>` in constant time before trusting it. A production API must add TLS, authentication,
authorization, rate limits and audit events before any command endpoint is
introduced.

When `ARMOR_MQTT_URL` is explicitly configured, the Node server subscribes to
`armor/node/+/telemetry` and `armor/node/+/health` at QoS 1. Invalid JSON,
unknown topic families and malformed payloads are rejected before reaching the
state projection. The broker credential is read only from the process environment.

The core intentionally does not execute MQTT commands. A future authenticated
adapter must enforce identities, authorization, audit logging and replay limits.
