# Settings of the server

Every setting is an environment variable (a `.env` file next to the server is read too). This table is generated from the code and from `.env.example`: change those, not this file.

| Variable | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `ARMOR_ADMIN_SOCKET` |  | `/run/armor/admin.sock` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_ADMIN_TOKEN` |  | `replace-with-long-random-admin-token` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_AI_TOKEN` |  | `replace-with-long-random-ai-token` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_ALARM_COMMANDS` |  | `0` | 1 lets this server arm, disarm and silence the panels of alarm nodes (off by default; the node and the broker have to allow it too). |
| `ARMOR_ALERT_DWELL_MS` | integer 0 to 60000, default 2000 |  |  |
| `ARMOR_ALERT_LANGUAGE` |  | `en` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_ALERT_MIN_TARGETS` | integer 1 to 20, default 1 | `1` | How many targets at once make an alert high while armed (1 by default), and how long an unacknowledged critical alarm waits before it is told again (minutes; 0 = never). |
| `ARMOR_ALERT_WEBHOOK_SECRET` |  | `replace-with-long-random-webhook-secret` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_ALERT_WEBHOOK_URL` |  | `https://example.org/armor-hook` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_BATTERY_WRITE` |  | `1` | The one way an order to write to a Pylontech battery (clock, counters, limits, outputs, serial number, firmware) leaves the server. OFF unless set to 1, and even then the gateway node has to have its own setting on (with the battery's service password stored only there) and the broker's ACL has to allow the maintenance topics. Only an administrator who has just proved themselves again can order it, with the battery's serial number typed. Some of it cannot be undone and can void the maker's warranty. |
| `ARMOR_CAMERA_CHECK_S` | integer 0 to 3600, default 20 |  |  |
| `ARMOR_CAMERA_CONFIG_KEY` |  | `replace-with-long-random-camera-config-key` | Stable, separate secret for AES-GCM camera credential storage. Rotating an operator/control token must not make configured camera passwords unreadable. |
| `ARMOR_CAMERA_DISCOVERY_CIDR` |  | `192.168.0.0/24` | Optional override for camera discovery. If omitted, ARMOR-SERVER scans its own private IPv4 /24 network through loopback-only API access. |
| `ARMOR_CONTROL_DISARM` |  | `1` | Disarming asks for the PIN of the signed-in user (and a user without one cannot disarm). Set, this wins over the setting alarm.disarm_pin of Studio's Security page (never, if_set, always): "required" is always, any other value is if_set. The control token does not know a person: with the PIN required it cannot disarm unless this is set to 1. |
| `ARMOR_CONTROL_TOKEN` |  | `replace-with-different-long-random-control-token` | Generate distinct random values; never commit the populated .env file. Address to listen on. Loopback by default; set 0.0.0.0 (or a LAN address) only on purpose. |
| `ARMOR_COOKIE_SECURE` |  | `1` | Set to 1 when the server is served over HTTPS. |
| `ARMOR_DATA_DIR` |  | `/var/lib/armor` | Where the server keeps its data (the folder "data" next to it when not set). |
| `ARMOR_DISARM_PIN` |  | `required` | Disarming asks for the PIN of the signed-in user (and a user without one cannot disarm). Set, this wins over the setting alarm.disarm_pin of Studio's Security page (never, if_set, always): "required" is always, any other value is if_set. The control token does not know a person: with the PIN required it cannot disarm unless this is set to 1. |
| `ARMOR_ELECTRICAL_SWITCHING` |  | `1` | The one way a command reaches the switch of an electrical node. OFF unless set to 1, and even then the node has to say it may switch and the broker's ACL has to allow it (scripts/mqtt_identity.sh electrical-switching). For a bench, a lamp behind an isolating transformer and a person present: nothing that switches has been built. |
| `ARMOR_ELEVATION_MS` | integer 30000 to 3600000, default 5 * 60000 |  |  |
| `ARMOR_ESCALATE_AFTER_MIN` | integer 0 to 1440, default 0 | `0` | How many targets at once make an alert high while armed (1 by default), and how long an unacknowledged critical alarm waits before it is told again (minutes; 0 = never). |
| `ARMOR_EVIDENCE_KEY` |  | `replace-with-long-random-evidence-key` | A key of its own for the proofs of custody of the evidence (otherwise the camera key signs them). |
| `ARMOR_FCM_SERVICE_ACCOUNT` |  | `/etc/armor/firebase-service-account.json` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_FFMPEG_PATH` |  | `C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe` | Optional absolute path to FFmpeg for the server-local RTSP-to-MJPEG relay. Keep this unset until the media gateway is intentionally installed. |
| `ARMOR_HA_DISCOVERY` |  | `1` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_HA_DISCOVERY_PREFIX` |  | `homeassistant` | The name Home Assistant discovery uses for its topics. |
| `ARMOR_HOMEASSISTANT_URL` |  | `http://192.168.0.20:8123` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_HOMEASSISTANT_WEBHOOK_ID` |  | `replace-with-the-webhook-id` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_HOST` |  | `127.0.0.1` | Generate distinct random values; never commit the populated .env file. Address to listen on. Loopback by default; set 0.0.0.0 (or a LAN address) only on purpose. |
| `ARMOR_INGEST_STRICT` |  | `1` | TLS of the server's own (it then speaks only HTTPS): |
| `ARMOR_INGEST_TOKEN` |  | `replace-with-long-random-ingest-token` | Generate distinct random values; never commit the populated .env file. Address to listen on. Loopback by default; set 0.0.0.0 (or a LAN address) only on purpose. |
| `ARMOR_LIVE_FPS` | integer 1 to 30, default 12 | `12` | TLS of the server's own (it then speaks only HTTPS): |
| `ARMOR_LIVE_WIDTH` | integer 160 to 1920, default 960 | `960` | TLS of the server's own (it then speaks only HTTPS): |
| `ARMOR_LOGIN_ALERTS` |  | `1` | 0 turns off the notice sent to the alarm channels when someone signs in from outside the house from a place not seen before. |
| `ARMOR_MAINT_SOCKET` |  | `/run/armor/maint.sock` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_MAINT_TOKEN` |  | `replace-with-long-random-maint-token` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_MAX_MJPEG_RELAYS` | integer 1 to 64, default 8 | `8` | Live views share one FFmpeg relay per camera. Studio supports up to eight simultaneous camera tiles; lower this only when the local CPU requires it. |
| `ARMOR_MEDIA_MAX_BYTES` | integer 64 * 1024 ** 2 to Number.MAXSAFEINTEGER, default 20 * 1024 ** 3 | `21474836480` | Evidence retention is oldest-first after the configured capacity or age. |
| `ARMOR_MEDIA_RETENTION_DAYS` | integer 0 to 3650, default 30 | `30` | Evidence retention is oldest-first after the configured capacity or age. |
| `ARMOR_MQTT_CA_FILE` |  | `/opt/armor/etc/mosquitto/tls/ca.pem` | Optional: encrypt the link to the broker (mqtts://). The certificate of the installation's own authority (one PEM file, from ARMOR-DEVOPS: scripts/armor_mqtt_tls.sh); the server then trusts that authority only. Needs an mqtts:// address above; with mqtt:// the server refuses to start. |
| `ARMOR_MQTT_PASSWORD` |  | `replace-with-broker-password` | Optional MQTT ingress. Leave unset for HTTP-only development. |
| `ARMOR_MQTT_URL` |  | `mqtt://127.0.0.1:1883` | Optional MQTT ingress. Leave unset for HTTP-only development. |
| `ARMOR_MQTT_USERNAME` |  | `armor-server` | Optional MQTT ingress. Leave unset for HTTP-only development. |
| `ARMOR_NODE_MAINTENANCE_MAX_S` | integer 60 to 3600, default 600 | `600` | The most seconds a node's own announcement of planned maintenance (a restart, an update, a pause) may hold back its offline alerts; after that the node counts as offline again (60 to 3600). |
| `ARMOR_NODE_STALE_AFTER_S` | integer 5 to 3600, default 30 | `30` | Seconds without a message after which a field node is reported stale and offline. |
| `ARMOR_NTFY_TOKEN` |  | `replace-with-the-ntfy-token-if-the-topic-needs-one` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_NTFY_URL` |  | `https://ntfy.sh/my-armor-topic` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_OPERATOR_SESSION_TTL_MS` | integer 60000 to 7 * 86400000, default 28800000 |  |  |
| `ARMOR_OPERATOR_TOKEN` |  | `replace-with-different-long-random-operator-token` | Separate operator token used by Studio for cameras, PTZ and evidence actions. |
| `ARMOR_PORT` | integer 1 to 65535, default 8080 | `8080` | Generate distinct random values; never commit the populated .env file. Address to listen on. Loopback by default; set 0.0.0.0 (or a LAN address) only on purpose. |
| `ARMOR_PUBLIC_ORIGIN` |  | `https://armor.example.org` | The address people use to reach it from outside, when a proxy in front of it speaks HTTPS: an https address also makes the session cookie secure. |
| `ARMOR_REMOTE_IDLE_MS` | integer 60000 to 7 * 86400000, default 30 * 60000 |  |  |
| `ARMOR_REMOTE_SESSION_TTL_MS` | integer 60000 to 30 * 86400000, default 12 * 3600000 |  |  |
| `ARMOR_STUDIO_ORIGIN` |  | `http://127.0.0.1:5178,http://localhost:5178` | Stable, separate secret for AES-GCM camera credential storage. Rotating an operator/control token must not make configured camera passwords unreadable. |
| `ARMOR_STUDIO_PASSWORD` |  | `replace-with-long-studio-password` | Required credentials for the Studio entry screen. Keep the populated values only in ignored .env; this example must remain non-secret. |
| `ARMOR_STUDIO_RESET_PASSWORD` |  | `0` | 1 sets the password of the administrator to ARMOR_STUDIO_PASSWORD at every start (to recover a lost one); take it out afterwards. |
| `ARMOR_STUDIO_SESSION_TTL_MS` | integer 60000 to 30 * 86400000, default 7 * 86400000 |  |  |
| `ARMOR_STUDIO_USERNAME` |  | `replace-with-studio-user` | Required credentials for the Studio entry screen. Keep the populated values only in ignored .env; this example must remain non-secret. |
| `ARMOR_TELEGRAM_BOT_TOKEN` |  | `123456:replace-with-the-token-from-botfather` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_TELEGRAM_CHAT_IDS` |  | `123456789` | Where alarms are told besides the apps: a webhook (signed with the secret), Telegram, ntfy, Home Assistant and Firebase push. |
| `ARMOR_TRUST_PROXY` |  | `loopback, uniquelocal` | Behind a reverse proxy (Studio's nginx in Docker): who the proxy is, so that the limits of the sign-in count each client and not the proxy itself. A number of proxies, an address or subnet, or names such as "loopback, uniquelocal". |
| `ARMOR_TZ` |  | `Europe/Madrid` | The time zone in which a "day" of energy (kWh) ends, for solar and electrical alike (an IANA name); the machine's own when it is not set. |
| `ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES` | integer 3200 to 1000000, default 200000 | `200000` | Where the most audio a spoken turn of the wall panel may carry starts, in bytes (480000 is 15 seconds of 16 kHz 16-bit mono; 3200 to 1920000), and the most spoken answer handed back to the panel in the binary form (200000; 3200 to 1000000). An administrator sets both in Studio (Configuration > Security); what is set there counts instead. |
| `ARMOR_VOICE_TOKEN` |  | `replace-with-long-random-voice-token` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `ARMOR_VOICE_TURN_MAX_BYTES` | integer 3200 to 1920000, default 480000 | `480000` | Where the most audio a spoken turn of the wall panel may carry starts, in bytes (480000 is 15 seconds of 16 kHz 16-bit mono; 3200 to 1920000), and the most spoken answer handed back to the panel in the binary form (200000; 3200 to 1000000). An administrator sets both in Studio (Configuration > Security); what is set there counts instead. |
| `ARMOR_VOICE_URL` |  | `http://127.0.0.1:18090` | The other services: the voice gateway, the observation service, the administration and maintenance agents of ARMOR-DEVOPS, Home Assistant discovery. |
| `TLS_CERT_PATH` |  | `/etc/armor/tls/cert.pem` | TLS of the server's own (it then speaks only HTTPS): |
| `TLS_KEY_PATH` |  | `/etc/armor/tls/key.pem` | TLS of the server's own (it then speaks only HTTPS): |
