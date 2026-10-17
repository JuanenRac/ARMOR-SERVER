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
| the command topics of the devices registered | write | a plug, a light |
| `homeassistant/#` | write | only with `ARMOR_HA_DISCOVERY=1` |

The broker's access list must give the server's account exactly that and nothing more (see ARMOR-DEVOPS). The topics of the nodes, of the server and of Home Assistant
(`armor/` except `armor/device/`, and `homeassistant/`) cannot be used as the state or command topic of a device: otherwise anyone who may create a device could make the
server publish a command to a panel. A **silent** alarm (a disarm with the duress PIN) is never put on `armor/server/alert`; it goes only to the webhook, Telegram and ntfy.
Commands to panels and switches are off unless the installation turns them on, and each one is checked and audited (see `docs/NODE_FIRMWARE.md` for what a node does with it).

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
