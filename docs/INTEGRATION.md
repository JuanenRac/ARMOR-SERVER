# First vertical integration

1. Generate JSONL with `ARMOR-SIMULATOR`.
2. Validate every envelope with `ARMOR-COMMON`.
3. Call `ArmorService.ingest()` only after validation.
4. Read `ArmorService.status()` from an authenticated API adapter.

The Node service provides `GET /healthz` and `GET /api/v1/status`. It accepts no
unauthenticated writes. A production API must add TLS, authentication,
authorization, rate limits and audit events before any command endpoint is
introduced.

When `ARMOR_MQTT_URL` is explicitly configured, the Node server subscribes to
`armor/node/+/telemetry` and `armor/node/+/health` at QoS 1. Invalid JSON,
unknown topic families and malformed payloads are rejected before reaching the
state projection. The broker credential is read only from the process environment.

The core intentionally does not execute MQTT commands. A future authenticated
adapter must enforce identities, authorization, audit logging and replay limits.
