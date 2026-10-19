# First vertical integration

1. Generate JSONL with `ARMOR-SIMULATOR` (`--server-url` and `--ingest-token` deliver it over HTTP).
2. Validate every envelope with `ARMOR-COMMON` (`--validate`); the server validates again at its boundary.
3. Read the state from `GET /api/v1/status` and the changes from `GET /api/v1/history`.

`tests/vertical-slice.test.ts` runs exactly this path with the real simulator and the real server.
The Node service provides `GET /healthz` and `GET /api/v1/status`. It accepts no
unauthenticated writes.

Alarms leave the server on MQTT `armor/server/alert` and, when `ARMOR_ALERT_WEBHOOK_URL` is set, as a
JSON POST. When `ARMOR_ALERT_WEBHOOK_SECRET` is set the body is signed: check
`X-Armor-Signature: sha256=<hex HMAC-SHA256 of the raw body>` in constant time before trusting it. The server has TLS of its own (`TLS_CERT_PATH` and
`TLS_KEY_PATH`), authentication by session or token, four roles, rate limits and an audit trail; keep it behind them when you expose it.

When `ARMOR_MQTT_URL` is explicitly configured, the Node server subscribes to
`armor/node/+/telemetry` and `armor/node/+/health` at QoS 1 (a health message with `"kind":"panel"` comes from a wall panel and is kept apart from the radars). Invalid JSON,
unknown topic families and malformed payloads are rejected before reaching the
state projection. The broker credential is read only from the process environment.
The link to the broker can be encrypted (optional, off by default): with an `mqtts://` address in `ARMOR_MQTT_URL` and `ARMOR_MQTT_CA_FILE` naming the certificate of the installation's own authority (one PEM file), the server trusts that authority only and the certificate of the broker must vouch for the name or address in the URL. The server refuses to start if the file is not one valid certificate or if it is set with an `mqtt://` address. `GET /api/v1/system/connection` (administrator) answers `mqtt_tls`: whether the link is encrypted and the name, fingerprint and end date of the pinned authority.

The server also subscribes to `armor/solar/+/+/state` and `armor/electrical/+/state` (QoS 1), the messages of the solar gateway nodes and of the electrical nodes, and accepts the same messages over `POST /api/v1/solar` and `POST /api/v1/electrical/readings` with the ingest token. Over MQTT the `node_id` in a body must be the node of its topic. An operator reads them with `GET /api/v1/solar` and `GET /api/v1/electrical/readings` (with their `/history`); the Electrical Designer's drawing is kept at `GET`/`PUT /api/v1/electrical/design`. The broker's ACL for `armor-server` needs `topic read armor/solar/#` and `topic read armor/electrical/#`.

### The topics the server reads and writes

| Topic | Direction | When |
|---|---|---|
| `armor/node/+/telemetry`, `armor/node/+/health`, `armor/node/+/info` | read | radar nodes |
| `armor/solar/+/+/state` | read | solar gateway nodes |
| `armor/electrical/+/state`, `armor/electrical/+/result` | read | electrical nodes |
| `armor/alarm/+/state`, `armor/alarm/+/result` | read | alarm panels |
| `armor/network/+/state` | read | ARMOR-NETWORK nodes |
| `armor/device/#` and the state topics of the devices registered | read | devices |
| `armor/server/alert` | write | every alarm that is not silent |
| `armor/alarm/<node>/command` | write | only with `ARMOR_ALARM_COMMANDS=1` (arm, disarm and silence the siren of a panel) |
| `armor/alarm/<node>/zigbee` | write | the state of the Zigbee zones of a panel |
| `armor/electrical/<node>/command` | write | only with `ARMOR_ELECTRICAL_SWITCHING=1` (a switch of a node) |
| `armor/solar/<node>/maintenance/command` | write | only with `ARMOR_BATTERY_WRITE=1` (an order to write to a Pylontech battery of a gateway node) |
| `armor/solar/+/maintenance/result` | read | the gateway nodes' answers to those orders |
| the command topics of the devices registered | write | a plug, a light |
| `homeassistant/#` | write | only with `ARMOR_HA_DISCOVERY=1` |

The broker's access list must give the server's account exactly that and nothing more (see ARMOR-DEVOPS). The topics of the nodes, of the server and of Home Assistant
(`armor/` except `armor/device/`, and `homeassistant/`) cannot be used as the state or command topic of a device: otherwise anyone who may create a device could make the
server publish a command to a panel. A **silent** alarm (a disarm with the duress PIN) is never put on `armor/server/alert`; it goes only to the webhook, Telegram and ntfy.
Commands to panels and switches are off unless the installation turns them on, and each one is checked and audited (see `docs/NODE_FIRMWARE.md` for what a node does with it).

## Headers of the API

Every answer under `/api/` carries `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; with a certificate of its own the server also sends a short `Strict-Transport-Security`. The panel of a node, passed on through `/api/v1/nodes/{id}/panel/`, keeps the headers of its own page.

## Alarms to Telegram and Home Assistant

Besides MQTT and the signed webhook, an alarm can be sent to a Telegram chat and to Home Assistant. They are set up in the settings file of the server (Studio >
Configuration > Settings files > `armor.env`, then restart the server) and tried from Studio > Configuration > Notifications, which sends a test message and says what
each place answered. The sentences are told in `ARMOR_ALERT_LANGUAGE` (`en`, `es`, `de`, `fr`, `it`, `ja`, `zh` or `pt`; `es` when it is not set).

**Telegram.** 1. In Telegram, talk to `@BotFather`, send `/newbot` and keep the token it gives (`123456789:AA...`). 2. Open a chat with your new bot (or add it to a group) and
send it any message. 3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `"chat":{"id":...}` (a group's id is negative). 4. Put in `armor.env`:

    ARMOR_TELEGRAM_BOT_TOKEN=123456789:AA...
    ARMOR_TELEGRAM_CHAT_IDS=123456789,-1001234567890

One message goes to every chat of the list. The server reaches `api.telegram.org` over HTTPS, so the machine needs a route to the Internet; the token is never written in the audit
trail or in an error.

**Home Assistant.** 1. In Home Assistant create an automation whose trigger is *Webhook*; copy the webhook id it shows (or choose one, 8 or more letters, digits, `-` and `_`).
2. Make its action what you want (a notification to the phone, a siren, a light), using the data of the call: `trigger.json.text` is the sentence for a person,
`trigger.json.title` is `A.R.M.O.R.`, and `trigger.json.event`, `node_id`, `severity`, `code`... say what happened. 3. Put in `armor.env`:

    ARMOR_HOMEASSISTANT_URL=http://192.168.0.20:8123
    ARMOR_HOMEASSISTANT_WEBHOOK_ID=armor-alerts-8f3a2c1d

The id is a secret (whoever has it can trigger the automation); the settings file shows it masked. Both places are tried again after 1, 4 and 15 seconds when they do not answer,
and every end - delivered or given up - is in the audit trail (`alert.telegram`, `alert.homeassistant`).

## Node health and arming profiles

Every setting the server reads is listed, with its limits and an example, in [ENVIRONMENT.md](ENVIRONMENT.md) (generated from the code).


* A node may also leave a last will on `armor/health/<node>`: the broker publishes `{"node_id":"<node>","online":false}` (nothing else in the body) when the node's connection is lost without a goodbye. The server takes it as "this node went away" at once instead of waiting for the silence limit, and it never counts as a report. A body that names another node than the topic is refused like any other. The other half is the birth: each time a node connects it says `{"node_id":"<node>","online":true}` on the same topic (retained, like the will), which the server takes as "this node is here" and never as a report, so the last message of the topic is always the state of the node, also after the server restarts.
* `POST /api/v1/node-health` (ingest token) and the topic `armor/health/<node>` carry the `node_health` report every node sends about once a minute. `GET /api/v1/node-health` lists the latest report of each node with its status (`ok`, `warning`, or `stale` after three minutes), its warnings, the restarts of the last day, the levels it judges by and the nodes it knows but that sent no report; `GET /api/v1/node-health/<id>` adds the history of its memory and signal (120 reports) and its restart log; `DELETE` (administrator) forgets a node. The latest reports and the restart logs are kept in `node-health.json` and survive a restart.
* The server judges, the node only tells. Four warnings reach the alarm centre (as warnings, never told outside the consoles): `node_low_memory` (under 30 KB of heap, cleared at 40 KB; or, when the node tells its internal memory on its own - `heap_internal_free`, `heap_internal_min`, `heap_internal_largest`, with `psram_free` for the external RAM -, under 40 KB of it, cleared at 48 KB, or no free block of 8 KB; or a task short of stack), `node_frequent_resets` (three restarts in a day, or a crash in the last hour), `node_link_flapping` (three connections to the broker in 15 minutes, or the link down in two of the last six reports) and `node_weak_signal` (-80 dBm or worse in three reports in a row). A restart is seen when the uptime or the count of connections goes back.
* `GET`/`PUT /api/v1/alarm/profiles` keep the arming modes (`arm-profiles.json`): at most eight, `away` and `stay` always there with their own base, the list replaced as a whole with a revision (a conflict is a 409). `POST /api/v1/alarm/command` accepts `profile` (the id) on an arm; the whole profile goes inside the command to the node, only if the node's state says `arm_profiles: true` (`profiles_unsupported` otherwise), and the base must be the mode. The profile's `notify` decides the severity of the alarm a sounding panel raises: `urgent` is critical (escalated), `normal` is high. An arm without a profile is the command it always was.

* The history also records the clients that connect and the system itself. `GET /api/v1/history` leaves the `connection` and `system` events out unless `type=connection`, `type=system`, one of their filters (`kind`, `client`, `category`, `user`) or `all=1` is given, so a client that only knows the older events never meets them. A `connection` event says that a client of a kind (`studio`, `android`, `node`, `voice`, `other`: what the client says in `X-Armor-Client: <kind>/<version>`, else what its user agent shows) was first seen, signed in, was refused (with a wrong password or a wrong code of the second factor), signed out, or had its session ended or expired; the name typed in a refused sign-in is kept only when it is the name of a real account. A `system` event uses a fixed vocabulary (nodes that appear, come back, change firmware or disappear; the broker link; settings changed, by whom and in which area, never the values; services; updates; the alarm armed, disarmed or silenced, with the arming profile) and has no free text. `GET /api/v1/history/connections` lists every client with when it was first and last seen and its open sessions. The address and the user agent of a client are in the answer only for an administrator signed in to Studio; a password, a token, a cookie or a PIN is never written, and the disarm under duress is never in the history. The clients are kept in `connections.json` (at most 300, forgotten after 120 days), the presence of the nodes in `node-life.json`, and the events in `events.log` with its rotation. The schemas are `connection_event`, `system_event` and `connection_client` in ARMOR-COMMON.
