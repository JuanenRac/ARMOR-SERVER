# State model

The store (`src/store.ts`) is the only owner of the perimeter state: the security mode and, per
field node, its last observation.

## Alert level

`alertLevelFor(mode, targets)`: no target is `normal`, any target is `review`, and two or more targets
while `armed` is `high`. Two rules refine it:

* **Dwell time** (`dwell_ms`, default 2000 ms): `high` is reached only when the two-target condition
  has held continuously for that long; until then the level stays `review`. The timer restarts when the
  condition breaks.
* **Ignore zones**: a target inside a rectangular zone (optionally for one node and sensor) is not
  counted.

Disarming clears `high` at once; arming re-evaluates every node.

## Node status

`online`, `stale` (silent for longer than the stale window) and `offline` (the node reported it, usually
through its MQTT last will). An `offline` message is always applied, even with an older timestamp,
because the last will is written before the node knows the time of its death. An older `online`
message is ignored and the stored timestamp never moves backwards.

## Time-driven changes

Silence and dwell time need no message, so a sweep runs every two seconds (`store.sweep()`), applies
them and emits the resulting events.

## Events

Every alert-level change, node status change and mode change becomes an event, appended to
`data/events.log` (rotated, restored at start) and offered through `GET /api/v1/history`. Alarms are a
subset (`alert.raised`, `alert.cleared`, and `node.offline` / `node.stale` while armed) sent by
`src/notify.ts`.

## Persistence

The mode is written to `data/state.json` immediately; node data is coalesced (about 750 ms) and flushed
on shutdown. At start the file is validated field by field; anything wrong is ignored. Restored nodes keep
their original reception time, so after a restart they read as stale until they speak again.

Adapters must authenticate callers before converting MQTT, HTTP or voice input into store calls.
