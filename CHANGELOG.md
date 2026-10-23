# Changelog

All notable changes to this project are documented here.

## [Unreleased]

- **Security option for the phone app's lock:** `client.device_lock` (`user` by default, `sensitive`, `always`) tells the phone app to ask for the fingerprint, the face or the phone's PIN also before arming, disarming and unlocking, or also to open the app. It is announced in `capabilities.security`, lowering it is written in the audit trail and raising it is not a loss; a phone with no lock is never shut out.

## [0.8.0.4] - Solar gateways remembered, the route list and the diagnostics of the nodes

- The repository has a security policy, a code of conduct, a contributing guide and a support file.
- The banner follows the animated style of the ecosystem banners, with the name, the kind and the technologies of the project.
- **A solar gateway is remembered across a restart:** like the electrical nodes, the alarm panels and the network watchers, the gateways (by gateway and device) are kept in `known-nodes.json`, so one that is dead when the server comes up raises `solar_offline` once its grace time has gone by instead of being invisible; decommissioning the node forgets its devices and ends their alarms.
- New `docs/ROUTES.md`: every route the server registers, with who may call it and the file that registers it, generated from the code (`node tools/routes_table.mjs`) and checked by a test.
- The sign-in alert in European Portuguese no longer uses the Brazilian form.
- **FFmpeg no longer receives the camera login in its command line:** the live picture, the snapshots, the recordings and the frames of the observation service read the camera through a local RTSP tunnel (`127.0.0.1`, a random word in the address, no user and no password) that adds the Basic or Digest login itself; the user and the password are no longer visible in `ps` or `/proc/<pid>/cmdline`. Tests start a camera that asks for Basic and Digest, check the 401 is answered inside the tunnel, a wrong first word is refused, the door closes, and the arguments given to FFmpeg by every one of the four users contain neither the user nor the password.
- **Security options that an administrator turns on and off from Studio:** `GET` and `PUT /api/v1/security/settings`, kept in `security-settings.json`, with the default of each being the way the server behaved before and every lowering written in the audit trail: `alarm.disarm_pin` (`never`, `if_set`, `always`; `ARMOR_DISARM_PIN` still works and wins when set), `voice.silence_confirmation` (`off`, `pin`, `double_turn`; sent to the voice service in the header `X-Armor-Policy` with every turn), `alarm.config_hash`, `server.zone_feed`, `server.zone_feed_signature` and `media.rtsp_proxy`. The duress PIN is not changed by any of them.
- **A spoken turn can be sent in binary:** `POST /api/v1/voice/turn` also takes `multipart/form-data` with the audio as raw bytes and an optional `meta` part (ARMOR-COMMON's *Voice turn* contract), and can answer `multipart/mixed` with the spoken reply as a part instead of base64 (`reply_audio` `binary`), JSON without audio (`none`) or the gateway's JSON as before (`base64`, the default). The part names, framing, sizes and types are checked (400, 411, 413, 415, 422) and the token is checked before the body is read; the raw request is unchanged. The sizes are settings (`ARMOR_VOICE_TURN_MAX_BYTES`, 480000 by default, and `ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES`, 200000) and the form is a security option, `voice.multipart_turn` (on by default). The voice gateway needs no change. New `tests/voice_turn.test.ts` (checked against the 43 shared byte-level cases).
- **A live channel for the wall panel:** the WebSocket `/api/v1/panel/events` sends the small summary of `GET /api/v1/panel/summary` when the panel connects, when it changes and every five seconds (`heartbeat_ms`), for the panel, operator and administrator accounts, so the touch panel hears of a change without asking every few seconds; it carries nothing else, takes nothing, drops a client that falls behind and closes with 4401 when the session ends. The option `panel.live_events` (on by default; an administrator turns it off in Studio) closes the panels on it with 4403 and refuses new ones, and the panel then asks as before. The summary is built in one place for the route and the channel.
- **The session announces its capabilities:** `GET /api/v1/studio/session` carries `capabilities` (what the person may do, the parts of the server that exist and the security options in force, with the ones the environment fixes), so Studio hides what the server does not offer; a server without the field is an older one.
- **The Zigbee zone messages can be signed, and switched off:** each message carries `seq` and `sig` (HMAC-SHA256 with the key of the panel, derived from a secret of the server and given to an administrator with `GET /api/v1/alarm/zone-feed/key/{node}`), and the new `armor/alarm/<node>/policy` message tells every panel the options that concern it. Panel side pending: the alarm panel does not yet read the policy, check the signature or bind its saved armed state to a hash of its zones and PIN; that comes with the next firmware batch.
- **The silence policy also goes with every written command:** the order sent to the voice service (`/v1/command`) now carries `policy` with the value of `voice.silence_confirmation` in its body, as the audio turns already did in the `X-Armor-Policy` header; a policy sent by the caller of the server is ignored. Tested against a stand-in service that follows the setting.
- **A device login can be kept from a node that did not come over TLS:** the new option `network.login_secure_only` (off by default, as before; an administrator turns it on in Studio) hands the stored login of a device to a network node only when the request came over TLS or straight from this machine. A test holds both states.
- **The administration shows how the admin agent protects the broker rules and the env files:** `GET /api/v1/admin/status` carries `sensitive_writes` (`mode`: `open`, `second_token` or `read_only`, and whether it is protected; `null` for an older agent), and a change to a broker rule, an env file or an account hands on the second secret the person gives in the header `X-Armor-Admin-Sensitive-Token`, for that request only and kept nowhere. A refusal of the agent (`sensitive_token_required`, `sensitive_read_only`) reaches the console with its own code.
- **Fixed:** the parsers accept the fields of the shared contract that were added to the electrical channel (`reading_age_ms`, `errors`) and to the inverter message (`clamped`); the shared vectors failed on them.

## [0.8.0.3] - Control of the nodes from Studio and the phone

- **Control of the nodes from Studio and the phone:** `POST /api/v1/nodes/{id}/control` (one node) and `POST /api/v1/nodes/control` (every node that reports) restart, pause, resume, put on standby, identify, read the diagnostics of and put in or out of maintenance, with `GET /api/v1/nodes/control/operations` and `/{id}` for what was ordered in the last weeks. For an administrator who proved themselves again a moment ago; the node's id (or the word RESTART, PAUSE or STANDBY for all nodes) is typed again for the three operations that leave the house less guarded. There is no operation that erases a node, sleeps it or sets a wake timer, and the server and the CM5 are never ordered.
- **Arm, one-time token, execute for each node:** the order is checked against the shared contract before it is published, the token (30 seconds, bound to the operation) is kept in memory only and never appears in a response, the history, the audit trail, a log or the file of operations, an answer is used once, and the answers of a node that names another node or an order that was not sent are dropped.
- **Rolling restart:** each node gets a place sorted by id inside its family, the families in a fixed order and the alarm panels last, thirty seconds apart; `now` acts on all together. A restart is followed to the end: acknowledged, offline, back with the time, or not back.
- **A line per node:** pending, armed, sent, acknowledged, applied, offline, back, refused (with the node's own reason: busy updating, uploading, copying a slot or running a battery operation, rate limited, already in that state), no answer or not back; the operations are kept in `node_control.json` without any token and a restart of the server ends the orders that were on their way.
- **Limits:** one order at a time per node, a restart at most once a minute per node, ten orders a minute altogether, and 503 when the broker is down (nothing is kept).
- **History and audit:** each step is a `system` event of the category `node` (`control_requested`, `control_acknowledged`, `control_applied`, `control_refused`, `control_back`, `control_lost`) with the person, the node, the firmware and the operation, and the audit trail says who ordered what from where.
- **Paused, standby and maintenance are visible:** `GET /api/v1/node-health` carries a `control` object per node, from the node's own report or from what the server remembers of the orders; the health report accepts the new optional fields; while a node is in maintenance or a restart that was ordered is under way the alarms and notifications about its silence are held back, and they come if the node is still silent when that ends.
- **Planned maintenance, one window per node:** the retained `node_maintenance` message of a node (`armor/control/<node>/maintenance`, also read when the server starts) and the operator's `maintenance_on` are one window: the node is expected offline while either is in force, so its offline alerts and the tamper inference are held back. A node's own announcement is bounded by the server (the time it expects or `ARMOR_NODE_MAINTENANCE_MAX_S`, 60 to 3600, default 600, whichever is shorter; repeating it adds nothing); an operator window keeps its duration, up to 8 hours. A node that returns (`active: false`, or a lower uptime) closes its window; when the time passes with the node still silent the alerts resume and the history records `maintenance_expired` (`maintenance_started` and `maintenance_ended` for announced windows). The windows are kept across a restart, listed by `GET /api/v1/nodes/maintenance` and shown in `control` of the node health (source, reason, time left).
- **Tests:** the shared vectors of both messages, the closed list of operations, the rolling plan, every operation with a fake broker, every refusal, replays, tokens that never leak, the restart that comes back or not, persistence, maintenance and the routes (administrator, fresh proof, confirmation, unknown node, conflicts, limits).
- **Documented:** the routes, the flow and the history in the integration notes and in the node firmware notes.

## [0.8.0.2] - The internal memory of the nodes and the birth of a node

- **The internal memory of a node is judged on its own** when the node tells it (`heap_internal_free`, `heap_internal_min`, `heap_internal_largest`, `psram_free`): the memory warning uses 40 KB (cleared at 48 KB) and a biggest block of 8 KB, the history keeps the internal figures, and the details of the warning carry them. A report with only some of the three internal fields is refused.
- **The birth of a node is understood:** `{"node_id":"<node>","online":true}` on `armor/health/<node>` (retained, said at each connection) marks the node as here and is never taken for a report, the other half of the last will.

## [0.8.0.1] - Orders to write to Pylontech batteries, off by default

- **Orders to write to a Pylontech battery, off unless `ARMOR_BATTERY_WRITE=1`:** `GET /api/v1/solar/battery-ops/catalog` (the table of the typed operations, their risk and their ranges), `GET /api/v1/solar/battery-ops` and `/{id}` (what was ordered, how far it is and how it ended), `POST /api/v1/solar/battery-ops` (arm), `/{id}/execute`, `/{id}/cancel`, `/{id}/restore` (puts an output back as it was) and `POST /api/v1/solar/battery-ops/images` (keeps a firmware image in memory for an hour). All of them are for administrators; the ones that order or upload need a fresh proof of identity (the password or the second factor) also inside the house, and a session from outside the house is treated as for the rest of the administration.
- **Two steps and a one-time token:** the server checks the node, the port, the operation and its values against the shared table (the maker's ranges, a group of limits whole and in order, a protection switched off only with the risk accepted, the expert console's block list), sends `arm`, keeps the token the node gives and never shows it (not in an answer, the list, the audit trail or the file the operations are kept in), and sends `execute` only for the person who armed it, within two minutes and with the battery's serial number typed again. One operation at a time per battery; an operation whose node goes quiet ends as lost.
- **A firmware image:** read for its board name, version, size, CRC-32 and SHA-256, kept in memory only, and sent to the node in 256-byte pieces, each acknowledged, before the arm; a piece that is refused or not acknowledged ends the operation.
- **Everything is kept:** who ordered what to which battery, what was read before and after, the difference, the node's transcript (already without the battery's service password) and how it ended, in `battery_ops.json` of the data directory (an operation that was on its way when the server stopped is called lost), and told to the history under the new *Batteries* category.
- **Documented:** `ARMOR_BATTERY_WRITE` in the environment table and the example file, the two maintenance topics in the integration notes.

## [0.8.0.0] - The details of a battery module, its event log and two new alerts

- **Module details:** a battery module may carry its model, the versions of its board and software, its cells, the current it allows each way, the speed of its console, the health of each cell and the newest entry of its event log; every field is checked on arrival against the shared contract.
- **The event log of a battery:** each new entry a node reads from a module is kept once, newest first, with the time the server saw it, survives a restart, and comes with the battery's device view; the protection fields are the console's own words, never decoded.
- **Two new alerts:** a cell that the battery itself marks as abnormal, and a module that carries more current than it says it allows (each with a margin before it ends).
- **Tests:** the new fields and the limits of each, the two alerts, the log (once per entry, in order, bounded and restored after a restart) and the device view.

## [0.7.9] - Calmer live feed, one table of broker topics, a last will for lost nodes and a generated settings table

- The live state sent to the consoles is now one message per short window with the newest state, so a burst of reports from many nodes no longer sends the whole state once per report.
- Everything the server listens to on the broker (solar, electrical, network, alarm and health nodes) is one table of routes with the same rule for all: the node named in the body must be the node of the topic.
- A node that is lost without a goodbye can leave a last will on its health topic (`{"node_id":"...","online":false}`); the server records the node as gone at once, and the will is never taken for a health report.
- The sessions of the operator console are now ended by the periodic sweep as soon as their time is over, like the Studio ones, and not only when somebody signs in.
- Closing the server now also stops the system monitor and the pending live-state message.
- The reading of the environment is split into one function per area (alarm channels, agents, the server's own HTTPS, the broker), with the same checks and messages as before.
- New `docs/ENVIRONMENT.md`: every setting with its limits, default and example, generated from the code and the example file and checked by a test.
- Each battery shows, per module, the lowest and the highest cell of the day with the cell number and the moment, the widest gap of the module, and the widest gap of the whole bank (`day_cells` in `GET /api/v1/solar`); they are kept across a restart and start again with the server's day.
- The alarm for unbalanced cells can ask the gap to last: the new level `cell_spread_minutes` (0 to 240, 0 as before: at once) is the time the gap must stay over its level before the alarm is raised, and it starts again whenever the gap drops back under it.
- A battery module may carry the counters of its life that its console prints (protections, errors, use; by the console's own names, lowercase with underscores). They are checked on arrival, and when a protection or error counter goes up the server raises an event (`solar_counter_rose`) saying which module and counter, from what to what; the first time a counter is seen it is only remembered.
- The battery catalogue follows the makers' manuals: the UP2500 is a 24 V battery of eight cells and about 111 Ah, the UP5000 has fifteen cells, and the UF5000 and the Fidus FB-L-5.12-EU (with its Pro variant) are in the list (16 cells, 100 Ah, 51.2 V). Each model carries its figures (nominal voltage, charge and discharge window, temperatures, group size) in `battery_profiles` of the solar catalogue, and a pack above the voltage at which its model's own protection acts raises a high alarm (`solar_battery_overvoltage`); a model with no such figure is not judged. Nothing assumes a 48 V battery.

## [0.7.8] - One limit of refused sign-ins for the whole server, and a complete settings example

- The Studio sign-in has a third limit, for the whole server: forty refused tries a minute in all, whatever the place or the account, so that many accounts tried from many addresses at once cannot make the server hash passwords without end. Only refused tries count; correct sign-ins are never held back.
- `.env.example` now names every setting the server reads (the data folder, the public address, the notices of sign-ins from outside, the recovery of the administrator password, the alarm commands, the Home Assistant prefix, and the webhook, Telegram, ntfy, Home Assistant and Firebase channels), and a test fails when a new setting is added to the code without being named there.

## [0.7.7] - Answers that cannot be cached and logins kept from contested addresses

- Every answer of the API says it must not be cached and may run nothing in a browser (`Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`), and a server with its own certificate adds a short `Strict-Transport-Security`; the passed-on panel of a node keeps its own headers.
- A stored login is not handed to a network node while that node reports an address conflict (two machines claiming the address) about the device in the last ten minutes: the node looks without a login.
- A saved weather place whose latitude or longitude is outside the globe is ignored like any other damaged entry.

## [0.7.6] - Damaged state files

- **A state file holding `null` no longer stops the server from starting:** the saved preferences and the saved cameras were read as an object without checking, so a file that had been emptied to `null` (a power cut, a hand edit) threw while the server was starting. They are now ignored like any other damaged file and start empty.
- More tests: the second factor under repeated wrong codes, expired challenges and proofs from outside the house, the automation engine with a fake clock, account and PIN edges, MQTT ingestion with hostile messages on a real socket, and every state file damaged in several ways at once.

## [0.7.5] - History of connections and of the system

- **Connections in the history:** every sign-in, refused sign-in, wrong code of the second factor, sign-out, session ended from the list of sessions and session that ran out becomes a `connection` event with the kind of client (Studio, the Android app, the panel of a node, the voice service, other), the user, the version it says it is, where it came from (inside the house or outside) and whether the second factor was used. A service with a token and the panel of a node opened through the server are clients too, seen once.
- **The list of clients:** `GET /api/v1/history/connections` gives every device or app the server has seen, with when it was first and last seen, its open sessions and its sign-ins and refusals, in a file that is bounded (300 clients, forgotten after 120 days). The clients tell what they are in the `X-Armor-Client` header (only informative).
- **Events of the system:** nodes that appear, return, change firmware or disappear, the link to the broker (once when lost and once when back), settings changed (who and in which area, never the values), services started, stopped and restarted, updates checked, installed and rolled back, and the alarm armed, disarmed, acknowledged or asked to arm, disarm or silence with its profile. They come from the audit trail through a fixed vocabulary, without its free text; a disarm under duress is never written.
- **Privacy:** the address and the user agent of a client are in the answers only for an administrator signed in to Studio; the name typed in a refused sign-in is kept only when it is a real account; no password, token, cookie, PIN or recovery code is ever recorded, and tests read the files of the history looking for them.
- **The history API:** `type` accepts `connection` and `system`; new filters `category`, `kind`, `client` and `user`; the new events are left out unless asked for (`type`, a filter, or `all=1`) so that older clients never meet them; the summary counts them apart in `by_type` and the sessions that run out are noticed without waiting for a request.

## [0.7.4] - Node health and arming profiles

- Node health: the report of every node arrives over MQTT (armor/health/{node}) or POST /api/v1/node-health, and GET /api/v1/node-health lists the latest report of each node with its status, warnings, restarts of the last day and the nodes that sent none; /api/v1/node-health/{id} adds the history and the restart log, DELETE forgets a node. Reports and restart logs survive a restart.
- Four warnings reach the alarm centre: node_low_memory, node_frequent_resets, node_link_flapping and node_weak_signal, with hysteresis for the memory and a restart seen when the uptime or the connection count goes back.
- Arming profiles: GET/PUT /api/v1/alarm/profiles keep up to eight modes (Away, Home and Night to start with; away and stay cannot be removed) with a revision against silent overwrites, and POST /api/v1/alarm/command accepts the id of one on an arm. The whole profile goes inside the command, only to a node whose state says arm_profiles; an arm without a profile is the command it always was.
- A profile with notify normal makes the alarm a sounding panel raises high instead of critical; the active profile is in the alarm detail.
- Tests for the parsers against the shared vectors, the store, the warnings and their levels, the routes and the commands (448 server tests in all).

## [0.7.3] - An optional encrypted link to the broker (mqtts)

- ARMOR_MQTT_CA_FILE names the certificate of the installation's own authority. With an mqtts:// address the server trusts that authority only and the broker's certificate must vouch for the name or address in the URL; without the variable an mqtts:// address is checked against the usual authorities of the machine, and an mqtt:// address is unchanged.
- The server refuses to start if the file is not one valid certificate, is expired, or is set with an mqtt:// address (the link would stay unencrypted while the owner believed otherwise).
- GET /api/v1/system/connection (administrator) also answers mqtt_tls: whether the link is encrypted and the name, SHA-256 fingerprint and end date of the pinned authority - never a path or the certificate text.
- Tests: the certificate file, the configuration, and a TLS broker stand-in that accepts the pinned authority and refuses another authority and a name the certificate does not vouch for; also run against a real Mosquitto 2.0.

## [0.7.2] - Silence the siren of a panel with the PIN

- POST /api/v1/alarm/command accepts action silence: the same rules as a disarm (administrator, the PIN of the signed-in user checked by the server and never sent to the node, the same lockout, audit entries control.silence, the remote policy and the three switches).
- The alarm centre keeps a silenced panel as it is: the sounding alarm stays open and unacknowledged until the disarm, because the alarm is latched and nobody has looked at its cause.
- The event kind siren_silenced and the action silence are part of the parsers, the OpenAPI file and the integration notes.
- Tests: 424 (before 421).

## [0.7.1] - Zones in trouble, estimated powers and wall panels

- A zone in trouble raises a warning for as long as it lasts (it never sounds the siren), and the state is accepted by the alarm contract.
- A grid figure that includes an estimated channel is marked as estimated (grid_estimated); the channel keeps its power_estimated flag.
- A health message from a wall panel (kind panel) is kept apart: it is not a radar node, does not count and cannot be a node that went down; the services list it as a wall panel.
- Tests: 421 (before 418).

## [0.7.0] - The server accepts the inverter warnings_known field

- An inverter message may carry warnings_known: false, which says that the inverter dialect cannot ask for its warnings (REVO), so the empty list means unknown and not none; the field is checked as a boolean and kept. Tests: 418 (before 417).

## [0.6.9] - The server now sends the marker a node demands when it signs in, adopts and updates it

- **Adopting a node and updating its firmware from Studio now work against a real node:** the server signed in, changed the settings and restarted the node without `X-Requested-With`, the marker the node's panel demands for anything that changes it, so a real node answered 403 (the stand-in node of the tests did not ask for it; it does now).
- The routes of this repository are unchanged; tests: 417.

## [0.6.8] - The panel of a node through the server, a warning for every new sign-in from outside, and the VPN and the dynamic DNS name from Studio

- **The panel of a node, reached through the server:** `/api/v1/nodes/<id>/panel/` passes an administrator to the web panel of a node that is not published anywhere. The address of the node comes from a list an administrator keeps (`/api/v1/admin/node-panels`: only addresses of the house, never one taken from the request), the connection to an HTTPS node is made only when its certificate is the one that was trusted (its SHA-256 is looked at and trusted from Studio) and nothing is written to it before that, the cookie of the node stays on the server (the browser never sees it and the node never sees the server's), the browser's Origin, Referer and Authorization are dropped, a path with `..` in any disguise is refused, bodies are limited (64 KB, 8 MB for firmware and settings) and every write is in the audit trail without its content.
- From outside the house a new panel asks for a new proof of identity once and then goes on until it has sat unused for fifteen minutes; with the policy `operate` or `view` the routes that change the node (firmware, factory reset, restart, users, settings) are refused from outside, and a viewer never gets in.
- **A warning for a new sign-in from outside:** the first time a person signs in from outside the house from an address they had not used, the places the alarms go to (Telegram, ntfy, Home Assistant, the webhook, the broker) are told, in the language of the installation (`ARMOR_LOGIN_ALERTS=0` turns it off). The new event `login.remote` is in the shared contract.
- **The VPN and the dynamic DNS name, asked for through the maintenance agent:** `/api/v1/admin/remote` and the routes under it set up WireGuard, add and remove devices (their configuration, with a private key, is never cached and never written down), and keep a name pointing at the house; each change asks a session from outside for a new proof and is in the audit trail without a key or a token.
- The installation file can now really be 9 MB: the general 64 KB reader no longer cuts it before its own reader sees it.
- The routes are in the OpenAPI file and the new alert event in the contract with its conformance vectors. Tests: 417 (before 409).

## [0.6.7] - Using the server from outside the house

- **Where a request comes from:** `ARMOR_LOCAL_NETWORKS` and `ARMOR_VPN_NETWORKS` say what is the house; every session records whether it came from inside or outside, the address and the browser, and `GET /api/v1/studio/sessions` lists them so the person can end the ones they do not know (also `end-others`).
- **Shorter sessions from outside:** 12 hours and 30 minutes without use (`ARMOR_REMOTE_SESSION_TTL_MS`, `ARMOR_REMOTE_IDLE_MS`).
- **Second factor (TOTP, RFC 6238):** set up with the password, confirmed with the first code, ten recovery codes shown once; the sign-in then answers with a challenge and gives no cookie until the code (or a recovery code) is right; a code is accepted once; five wrong codes make the next tries wait; an administrator can reset it. `ARMOR_TOTP_REQUIRED=remote|always` demands it (a person without it sets it up from inside first).
- **A new proof for critical actions from outside:** managing users and PINs and starting a firmware update ask a remote session to prove itself again (`POST /api/v1/studio/elevate`, good for five minutes). Inside the house nothing more is asked.
- **`ARMOR_REMOTE_POLICY`** (`full`, `operate`, `view`) closes administering, or everything but looking, to sessions from outside, answering `remote_policy`; `GET /api/v1/remote/check` shows what the server sees of a request.
- `ARMOR_COOKIE_SECURE` left empty (what the Compose file passes) now follows the installation again: Secure with TLS or an https public origin.
- A page, `docs/REMOTE_ACCESS.md`, and the routes in the OpenAPI file. Tests: 409 (before 402).

## [0.6.6] - Releases that must be signed, the wall panel's voice through the server and a few contracts brought together

- **A firmware release is installed only when its manifest is signed** (`<image>.sig2`, Ed25519, the key of the releases): "Node firmware" used to check only the `.sha256` published in the same release, so whoever could change a release on GitHub could change both and have the server push his firmware to every panel. A release without the signature or with another key is refused (`no_signature`, `bad_signature`); an image uploaded by hand is still the administrator's own act. A test compares the key with the one the nodes carry.
- **The wall panel can reach the voice gateway:** `POST /api/v1/voice/turn` (and `/api/v1/voice/v1/turn`, which is what the panel builds from the address `<server>/api/v1/voice`) takes the panel's audio with the voice token and passes it to the gateway on this machine, which listens on the loopback only; each panel has its own pending question.
- **The contract and the server agree:** a node `firmware` may have four parts (the odometer from 0.8.0.0), and a node that reports a network outside 10/8, 172.16/12 and 192.168/16 is refused, as the shared vectors say.
- Telemetry and health over HTTP ignore a field they do not know yet, and say so, as over MQTT; solar and electrical readings sent without a clock get the arrival time like the radar's.
- A viewer's phone may take its push token back (`/push/unregister`); the observation service has its own, larger allowance of pictures and may say the share of the picture that moved (`motion_ratio`); `/alarm/state` and `/devices/state` are exempt from the anonymous limit like the other ingest routes.
- Studio shows why a release was refused (new texts in eight languages); the OpenAPI file describes the voice routes. Tests: 402 (before 399, with the contract vectors now passing).

## [0.6.5] - A duress disarm that stays silent, alarms that tell the truth after a restart, and a safer push

- A disarm with the duress PIN is now SILENT. The alarm it raises used to be an ordinary critical one: it showed on the wall panel's summary (which sounded the siren tone and turned the screen red in front of whoever was forcing the person), went to the broker topic every panel listens to, set off the automations, and could be acknowledged by the panel itself. It is now told only to the webhook, Telegram and ntfy, is not in the event history, the summary, the voice answers or the count of the system, sets nothing off, and only an administrator signed in to Studio sees it, acknowledges it or deletes it. The text says what to do ("do not call them, call for help").
- An acknowledgement that proves nobody (the wall panel's account, a voice command) no longer stops a critical alarm from being escalated: the alarm leaves the unread list but is marked unverified and keeps being told again until a signed-in person acknowledges it.
- Event alarms (a duress disarm, a watched device that came onto the network, a camera that saw movement) are raised already ended and leave the list when acknowledged, instead of staying on the counter for ever; a camera's movement is one alarm per five minutes, where the first one used to silence that camera for good (and a deleted one muted it for good).
- A device can no longer be given the topics of the nodes, the server or Home Assistant as its state or command topic (`armor/` except `armor/device/`, and `homeassistant/`): any operator could make the server publish a disarm to a panel, hide a zone or inject false alarms.
- The control token can no longer disarm while `ARMOR_DISARM_PIN=required` (it knows no person and takes no PIN) unless `ARMOR_CONTROL_DISARM=1` says so. Two secrets with the same value (the ingest token and the control token, say) are refused at start, and a missing operator token is warned about.
- Push: the channel ids sent to the phone are the ones the Android app creates (`armor_alarm_critical`, `armor_alarm_warning`, `armor_alarm`); before, a critical alarm landed in a silent default channel. A phone belongs to the person who registered it (at most five each), leaves with them when the user is removed or their password or role changes, a full list is not emptied of other people's phones, a retry goes only to the phones that did not get the message, each phone has its own time limit, and a token Firebase calls invalid is dropped.
- Notifications: every place (webhook, Telegram, ntfy, Home Assistant, push) has its own queue, so one that is down delays only itself, and a critical message goes in front of the others.
- Nodes that are dead when the server comes up are no longer invisible: the electrical nodes, alarm panels and network watchers that have ever spoken are remembered on disk, and one that stays silent after the grace time is reported (an alarm, and a blocking finding in the check before arming). A node that speaks again, or a camera that answers, brings down an "offline" alarm raised before the restart. Taking a node away (`DELETE /api/v1/nodes/{id}`) now works for all these kinds and ends their silence.
- Sign-in: the limit is per account and place (and wider per place), not one counter for the whole house behind Studio's proxy; `ARMOR_TRUST_PROXY` names the proxy that may say who the client is. The count of wrong PINs is kept on disk (a restart gave three more tries), and the lock goes up to an hour.
- Camera and device logins that cannot be opened with the key in use are kept as they are and written back (rewriting the file without them lost them for good), with a copy of the file made first. The login inside a camera's snapshot address is refused and, when stored before, hidden from everyone.
- A recording that ended on its own (the camera unplugged, the connection reset) keeps what was recorded instead of deleting it; a camera that asked for Digest is never sent its password in Basic; the ONVIF endpoint of a camera is looked up once instead of on every press; automations that switch something back after N seconds extend the wait when they fire again; the voice does not switch a light marked as something that matters; an example reading is refused for solar equipment that is reporting for real.
- The proof of custody reads the rotated audit files too, says whether the trail reaches back to the file (`custody_complete`, `audit_from`), is signed with `ARMOR_EVIDENCE_KEY` (else the camera key) and is checked against every key still known, so rotating the control token does not void the proofs.
- WebSocket: accepts almost nothing from the client, drops a client that falls behind, pings, and closes (4401) a socket whose session ended. Home Assistant discovery keeps running after the broker drops once, withdraws the entities of a node that was taken away, and its "fault" sensor means what the server means by it. Solar and electrical energy are added up per day in one time zone (`ARMOR_TZ`). A grid-feeding meter's negative power is kept. The console writes the command to the audit trail before sending it. `GET /api/v1/info` shows the version and uptime only to a signed-in client.
- The container image carries FFmpeg (the live picture, snapshots, recordings and the observation frames did nothing without it) and its health check understands the server's own TLS. Docs and `.env.example` brought up to what the code does (alert threshold, roles, topics read and written, the variables); the deployment target is the CM5 that was tested.

## [0.6.4] - Push to the phones through Firebase, when the installation has its own project

- Push through Firebase Cloud Messaging, off by default: it is on only when ARMOR_FCM_SERVICE_ACCOUNT names the service account file of the installation's own Firebase project, and it sends only what the other channels already send.
- A phone registers the token of its app with POST /api/v1/push/register and takes it back with DELETE; a viewer's phone may do it too. An administrator reads GET /api/v1/push/status.
- The server makes its access token from the service account (a signed JWT exchanged at the token endpoint), reuses it for most of its hour, and drops a phone that Firebase says is gone.
- At most 50 phones are kept (the oldest registration makes room) in a private file of the data directory; nothing is logged with a token, a key or an address in it.

## [0.6.3] - Zones of a camera's picture to ignore

- New routes GET and PUT /api/v1/cameras/{id}/ignore-zones: an operator reads the zones of a camera, an administrator replaces them (at most sixteen rectangles inside the picture, as fractions from the top left).
- The zones are handed to the observation service with the camera in /api/v1/ai/context, are kept in the data directory, survive a restart and go with the camera when it is removed.
- Nothing is cut from the video or the photos: only the movement detection leaves those pixels out.
- The OpenAPI file documents the routes, and tests cover the validation, the store, the roles, the unknown camera and the context.

## [0.6.2] - Portuguese in the voice answers and the alert texts

- The answers of the voice commands (state, alarms, nodes, cameras, radars, solar, power, network, time, lights, help) and the confirmations are available in Portuguese.
- The text of the alerts sent to Telegram, ntfy, the webhook and the other channels can be written in Portuguese.
- The tests that count the languages expect the eight.

## [0.6.1] - Photos and video taken by themselves when a camera sees something while armed

- When the AI observation service reports something on a camera while the system is armed, the server now takes the evidence by itself: a photo or several, and a video of the configured length, through the same snapshot and recording of the evidence library.
- New settings in GET and PUT /api/v1/capture-settings (everybody who may look reads them, an administrator sets them): on or off, photos on or off, how many (1 to 60) and how far apart (1 to 300 s), video on or off and its length (3 to 300 s) and a cooldown per camera (5 s to an hour).
- A camera is not captured again during its cooldown, a recording a person started is left alone, a photo or recording that fails is skipped, and each capture is audited.
- The latest captures are returned with the settings; the settings survive a restart.
- The OpenAPI file documents the route, and tests cover the validation, the burst of photos, the video, the cooldown, a failing camera and the roles.

## [0.6.0] - A login for a network node is sealed for it alone, and the Zigbee zones of the alarm panels are told to them

- The login of a device of the network (a router, a NAS, a camera) that an inspection order carries now reaches only the node that spoke with its own token, and travels sealed for that node (HMAC-SHA256 keystream and tag, key from the node's token): it is not readable on plain HTTP and no other node can open it.
- A board provisioned the old way with the shared ingest token no longer receives any login with its orders; it inspects without one until it is given its own token.
- New route GET and PUT /api/v1/alarm/zone-links: an operator reads which Zigbee device is which zone of which panel, an administrator replaces the links (at most 64, one device per zone).
- While the server holds the Zigbee radio it publishes the state of each linked zone on armor/alarm/<node>/zigbee (normal, triggered or tamper, and a low battery) on every change of the device and every 30 seconds, so a restarted panel or a lost message heals by itself.
- A device that does not answer says nothing, so the panel's own supervision of silent sensors judges it; the message is information and never a command.
- The OpenAPI file documents both changes, and tests hold the sealed format, the strict links and the role of each caller.

## [0.5.9] - A check before arming, a viewer role, escalation, ntfy, proof of custody and daily electrical energy

- `GET /api/v1/preflight` reports what would leave the perimeter blind or noisy before arming: a radar node that does not answer, a silent alarm panel, an open zone, a camera that is down, an open door or window and alarms nobody has seen, each blocking or only a warning.
- A `viewer` role (family, guards) that can read the state, the alarms, the cameras, the history and ask for a camera's stream ticket, and can change nothing; what holds secrets or settings is closed to it even to read.
- A critical alarm that nobody acknowledges within `ARMOR_ESCALATE_AFTER_MIN` minutes is told again, once, to every channel as unattended (off by default).
- ntfy as a channel for the alarms (`ARMOR_NTFY_URL`, `ARMOR_NTFY_TOKEN`): a push to the phone with the highest priority for a critical alarm.
- `GET /api/v1/media/.../proof` gives a signed proof of custody (size, SHA-256 now and every audit line about the file) and `POST /api/v1/media/proof/verify` says whether a proof is genuine and the file still matches it.
- `GET /api/v1/electrical/energy` gives the energy of each channel per day, adding only the difference between readings so a meter that wraps at 9,999.99 kWh or restarts from zero does not break the sum.
- A test walks every role over the routes it is meant to reach and the ones it is not, so a role cannot gain or lose access unnoticed.
- The routes are described in the OpenAPI contract.

## [0.5.8] - Per-node ingest tokens, a hardened firmware job, quicker logins and alarm coverage by camera

- Each node can have its own ingest token (derived from the shared one and the node's identity) and the server can refuse the shared token entirely; the token of a node is shown to administrators.
- The firmware job waits between nodes, closes each connection, retries a node that did not answer and reports which step failed, so updating several nodes in a row no longer fails at the second one.
- Signing in hashes the password without blocking the server, so a login no longer stalls the live video and the polls.
- The summary of the versions of the system is cached and the registry gives a node a short grace after the server starts before calling it offline.
- The audit records who opened a camera or a recording, not only that it was opened.
- A network command that no agent picked up is offered again up to three times before it is given up.
- The cameras that the AI covers list the radar nodes that cover them, which lets Studio open the right camera for a radar alarm.
- An automation can trigger when a reading goes above or below a value.
- A spoken order is tied to the user who gave it and cannot be confirmed by another.
- The OpenAPI file describes the maintenance routes, the system check, upgrade and reboot, and the node token.

## [0.5.7] - Device kinds for shutters, gate and garage motors and water heaters; maintenance routes in the contract

- New device kinds `shutter`, `gate_motor`, `garage_motor` and `water_heater`: open and close commands for the motors (state field `open`) and on and off for the water heater.
- The maintenance routes (programs, updates, history, jobs and console) are described in the OpenAPI contract.
- `POST /api/v1/admin/system/upgrade` takes a `mode`: `upgrade` (default), `full` (full-upgrade) or `repair`; anything else is refused (422) and the mode is written in the audit trail.
- **Firmware jobs with several nodes:** between one node and the next the job waits a moment, every request to a node asks the node to close the connection after it (a small node closes idle sockets, and a pooled one could be dead when its turn came, minutes later), the first look at a node is tried three times and the sign-in with the upload twice; a failure of the second node no longer needs a new job.
- The list of the last operations can be emptied (`DELETE /api/v1/admin/updates/history`).

## [0.5.6] - Maintenance: updates from GitHub, the system's updates and the root console

- `/api/v1/admin/updates`, `/updates/{id}/rollback`, `/system/check|upgrade|reboot` and `/maintenance/jobs/{id}` ask the maintenance helper (its own Unix socket and token, ARMOR_MAINT_SOCKET and ARMOR_MAINT_TOKEN) to compare what is installed with the newest release of each program on GitHub, install them, put the previous one back and update the operating system, with the progress of every job.
- `/api/v1/admin/console` (state, unlock, lock, run, follow a job, cancel): a root console that is off unless the helper has it on, asks the administrator for the password again before the first command and after ten minutes without use, closes the door for five minutes after five wrong passwords, and writes every command and how it ended in the audit trail.
- Everything is for administrators only; an operator gets a refusal and the helper is never asked.

## [0.5.5] - The alarm design

- `GET` and `PUT /api/v1/alarm/design` (and its versions) keep the house's alarm drawn in Studio's Alarm Designer, the way the electrical and network drawings are kept: one document with a revision, a save made from an out-of-date copy is refused, and the earlier versions can be taken back. It is a drawing: nothing arms, disarms or sounds anything.
- The installation file carries the alarm design too (`alarm_design`).

## [0.5.4] - Durable state, safer firmware uploads and history

- The state of the alarm and the pending automation reversals are written durably (fsync and a backup copy); if the state cannot be read the house starts ARMED.
- Arming raises what is already wrong at that moment: a node or a camera that is down and a door left open while it was disarmed. A disarmed panel that goes quiet no longer wakes anybody.
- The firmware upload checks that the image is for the right kind of node, with clear errors (wrong_image_kind, wrong_node_kind).
- The history can be read after a cursor (`after`), and deleting it needs an administrator.
- Recordings are fragmented MP4, so a cut in the middle keeps what was written; the memory of muted alarms is bounded.

## [0.5.3] - A PIN to disarm; an alarm while disarmed is accepted; a central that sounds reaches the phone

- **`parseAlarmMessage` accepts `phase: alarm` with `mode: disarmed`** (it rejected the whole message, so a smoke detector sounding in a disarmed house was invisible to the server).
- **Alarms of an alarm node and of the network are told** like any other (Telegram, Home Assistant, the webhook and `armor/server/alert`): `alarm_sounding`, `alarm_tamper`, `alarm_locked_out`, `alarm_offline` and the network alarms, armed or not; the message carries `alarm_node_id` or `network_id`.
- A trigger of an automation can start from any source that exists (`solar`, `electrical`, `network`, `alarm`), not only node, camera and device.
- **A PIN to disarm, checked here:** each user can have a PIN (4 to 10 digits, kept as a salted hash) and a second, duress PIN. `POST /api/v1/mode` with `disarmed`, a command to disarm an alarm node and the voice command to disarm all ask for the `pin` of the signed-in user whenever the user has one; with `ARMOR_DISARM_PIN=required` a user without a PIN cannot disarm at all (`pin_not_set`). Three wrong PINs lock that user for a minute, then five, then fifteen (`pin_locked`, with `retry_after_s`). The duress PIN disarms like the right one and raises a critical `duress_disarm` alarm that goes to every place that tells a person. Before, a signed-in operator, the wall panel or the voice could disarm with no PIN at all.
- `PUT/DELETE /api/v1/users/{id}/pin` (administrator) and `PUT /api/v1/account/pin` (yourself, with your password) set and clear the PINs; the users list says `hasPin` and `hasDuress`, never the PIN.
- **A radar whose sensors died no longer stays online:** once a node has sent telemetry, only telemetry keeps it from going stale; its heartbeat alone does not (the node stops sending telemetry on purpose when its sensors fail, but kept sending its heartbeat).
- **One target is an intrusion:** while armed, a single target that stays for the dwell time makes the node's alert high (`ARMOR_ALERT_MIN_TARGETS`, 1 by default; 2 restores the old rule that ignored a lone intruder).
- **A SOS button sounds the panic alarm:** the words of the `action` of a Zigbee2MQTT button (`single`, `double`, `hold`, `emergency`, `sos`...) are a press, and a press ends by itself after 30 s so that the next one is a new alarm. Before, the word was not understood and the panic never sounded.
- **The inventory of the cameras needs a session:** `GET /api/v1/camera-views` (address, ports, paths and, on many cameras, a snapshot URL that holds the login) answered anybody on the LAN.
- **The list of alarms keeps what matters:** past 400, the oldest alarm that is over (and was acknowledged) goes, never one that is still going on or that nobody has seen. An alarm that is going on and unseen must be acknowledged before it can be taken off the list (`acknowledge_first`).
- **A live picture no longer freezes** when FFmpeg writes a lot to its error output: it is read and dropped.
- **A critical circuit is an administrator's:** lowering how much a device matters to switch, or making an automation that switches a circuit, needs an administrator, and an automation never switches a critical circuit.
- **Erasing the whole history or every recording needs an administrator.** The administrator-password check for opening the server to the network looks at the password that works now.
- **A file damaged by a power cut is not the end:** files are forced to the disk before they take the old one's name; `state.json` and `users.json` keep the last good copy (`.bak`) and are restored from it; with none, the server starts ARMED (state) or puts the damaged users file aside (`users.json.damaged`) instead of writing the seed over it.
- **"Switch it back after N seconds" survives a restart:** the pending reversals are kept in the automations file and done after the start, so a siren or a light turned on by an automation is not left on for ever.
- **Recordings:** written as fragmented MP4 (playable however they end), at most one hour each (`maxRecordingS`), closed cleanly when the server stops, and the ones a crash left behind are given their name again (or removed when empty).
- **Telegram:** a chat that refuses the alarm no longer stops the others from getting it, and a retry goes only to the chats that did not get it.
- **The voice's "silence the alarms" tells the truth:** it acknowledges them and says that a sounding siren is not switched off by it.
- **Adopting a node** makes the account of its kind (radar, solar, electrical, network or alarm); every adopted node used to get a radar's account and stayed mute. A radar with a newer firmware that adds a field is no longer refused whole, a node without a clock that restarts over HTTP is stamped with the time it arrived (as over MQTT), and the events of a network node that restarted its counter are not taken for old ones.

## [0.5.2] - The alarm nodes, and the firmware of every board

- **`alarm.ts`, the state of the ARMOR-ALARM nodes** (`armor/alarm/{node}/state` over MQTT, `POST /api/v1/alarm/state` over HTTP with the ingest token, `GET /api/v1/alarm/nodes` for the consoles): the strict parser of the shared contract (the 81 conformance vectors pass; a field a newer node adds is dropped and said, never kept), the latest state of each node, a node that goes quiet for thirty seconds marked stale, and the sums (nodes, stale, armed, sounding).
- **The alarms a panel raises:** a sounding alarm is `alarm_sounding` (critical) and ends with the disarm; a zone in tamper is `alarm_tamper` (high); a panel locked out after wrong PINs is `alarm_locked_out` and a silent node `alarm_offline` (warnings). They come from the node's own panel and do not depend on this server's security mode. The alarm source type `alarm` is accepted by the automations.
- **`alarm_commands.ts`, the only code that can arm or disarm a panel, and it is OFF** (`ARMOR_ALARM_COMMANDS=1` turns it on, with a start-up warning). `POST /api/v1/alarm/command` (an administrator) takes `{node, action, mode?, force?}` and publishes the contract's command, never retained and at most once; there is no PIN anywhere in it. It refuses when the commands are off, the node is unknown or quiet, the node says it takes no commands, or another command to it is waiting; every refusal and every answer is audited, and an answer to nothing that is waiting is dropped. `GET /api/v1/alarm/commands` shows what became of the latest ones. Off by default at three places: this server, the node (`server.commands`) and the broker's ACL (`mqtt_identity.sh alarm-commands`).
- **Firmware of the alarm node** can be updated from Studio like the others: the kind `alarm` takes the newest release of ARMOR-ALARM, and for each node the image of its own board (`armor_<kind>-<board>.bin`, with the plain name only for the default board), checked against the SHA-256 the release publishes.
- **The version of each service** in `GET /api/v1/system/services` (`version`): the server's own, Studio's from the `version.json` it publishes, the broker's from `mosquitto -h`, the Python services' from the `__version__` of their package (found through the unit's `PYTHONPATH` and working directory), and a radar's firmware from its info message; a version that cannot be told is left out. Nothing runs as a command: the unit's own `ExecStart` is read, never executed (only the broker's binary is asked for its version).
- **What an inverter says about itself** is kept: its serial number, firmware, the energy its panels have made in all (Wh) and its ratings and settings (the new optional fields of ARMOR-COMMON's inverter message, parsed as strictly as the rest and agreeing with every shared vector).
- **The whole installation as one file** (`GET` and `POST /api/v1/admin/installation`, administrators only, in the audit): the cameras (without their passwords), the designs of the site, the electricity and the network, the rules, the automations, the devices, the solar equipment and the energy alarm levels, and the users' names and roles for the record. Nothing secret is in it (a test looks for the camera's password, the tokens and every hash). Importing replaces the designs (which keep their previous version), the rules and the alarm levels, only adds what is missing of the lists (cameras, automations, devices, solar equipment) and leaves the rest alone; a part that does not check out is reported and skipped without spoiling the others, a camera that is imported needs its user name and password typed in again, and the users are never imported.
- **A `panel` role** (least privilege) for a wall panel's own account: it may read `GET /api/v1/panel/summary`, change the mode and acknowledge alarms, and every other route answers 403 for it (and it is not an operator for the cameras' tickets either). The summary now carries an `energy` block (the power of the panels and of the house, the battery's charge and power, and whether the solar equipment reports at all).
- **Home Assistant's MQTT discovery** (off unless `ARMOR_HA_DISCOVERY=1`, with `ARMOR_HA_DISCOVERY_PREFIX` for a prefix other than `homeassistant`): the sensors of each solar inverter and battery, the channels of each electrical node and the state and zones of each alarm panel are described once, retained, and again every ten minutes and when something new appears; every entity reads the topic the node already publishes (it can look at the installation and cannot command it).
- **Tests:** 13 for the alarm nodes (the shared vectors, the topics, the store, every refusal of the commands, the alarms and the routes) 2 for the board-aware release and 2 for the versions of the services.

## [0.5.1] - Nodes heard without a clock or with newer fields, a log of what they send, a month of history and the energy of each day

- **How much it matters to switch a device from afar** (`risk`: `low`, `circuit`, `critical`). A light or a plug goes with a click; a circuit of the board (the default of a breaker) needs `confirm: true` in the command or the server answers 409 `confirmation_required`; a critical one (a freezer, a pump, the alarm) also needs an administrator (403 `admin_required` for an operator token).
- **The electrical side of the house is not only the nodes' meters any more.** Two new kinds of device (`smart_breaker`, a circuit-breaker of the board that can be switched from afar, and `energy_meter`) and the fields `voltage_v` and `current_a` next to `power_w` and `energy_kwh`, so a Zigbee (or Wi-Fi) plug, breaker or meter reports all its measures. `GET /api/v1/electrical/devices` lists every device that measures or switches electricity with what it says, whether it can be switched and the totals (power and energy).
- **The levels of the energy alarms are the operator's** (`GET` and `PUT /api/v1/solar/alarms`, kept in `energy-alarms.json`): the charge that is low and the one that is enough again, as before, and now also the spread of the cells of a battery, its temperature (too hot; too cold while it charges), how worn it is and how hot an inverter's heat sink may get. Five new alarms: `solar_cells_unbalanced`, `solar_battery_hot`, `solar_battery_cold`, `solar_battery_worn` and `solar_inverter_hot`; each ends with a margin so a value on the edge does not flap.
- **A node that has no clock yet is heard anyway.** A radar, health or info message whose time is not a date (the time since the node started, which is what a node sends while it has no clock) is stamped with the moment the server receives it; a real date is kept as it came.
- **The battery and inverter messages take the new optional fields of the contract**: `power_w`, `balancing`, `protecting`, `charge_mos` and `discharge_mos` of a battery stack (what a battery management system adds) and `bus_v` of an inverter. The example readings carry them, so the menus can be tried without a node.
- **A node with newer firmware is no longer refused for a field the server does not know.** The readings of solar, electrical and network nodes (over MQTT and over HTTP) are read forgivingly: a field that is not in this server's contract is dropped and listed, and everything the server does know is checked exactly as before. What can move a switch (commands, results, the objects of a switch, a field called command) is still read exactly.
- **`GET /api/v1/system/ingest`** says, for every topic, how many messages were taken and refused, which unknown fields were ignored and the last refusal with the start of what was sent, so a node that does not show up has a reason to look at. The refusals were only a line in the server's own log before.
- **The history of solar and electrical readings survives a restart** (kept in `solar-history.json` and `electrical-history.json`, written once a minute) and reaches back a month: past a day the charts get five-minute averages (`minutes` up to 43200 in `/solar/history` and `/electrical/history`).
- **`GET /api/v1/solar/energy?days=`** gives the energy of each day in kilowatt-hours: what the panels made, what the load used and what the battery took and gave (from the stacks, or from the inverters when there is no stack), added up from the readings and kept across restarts.
- **Versions of a design can be forgotten:** `DELETE /api/v1/site/versions/{id}` (also `/electrical/design/...` and `/network/design/...`) removes one kept version and `DELETE .../versions` removes all of them, so old copies that no one needs do not pile up. The current design is never touched; each deletion is written to the audit log.
- `GET /api/v1/system/services` reports a program whose process is frozen by a signal (state T in `/proc/<pid>/stat`) as `paused`; systemd still calls it active. The administration route accepts the two new actions `pause` and `resume` (the agent refuses to pause the server and Studio). The voice service's line in the catalogue says fifteen commands, not four.
- **The address of a node's panel is kept in the state file** (it used to be forgotten at every restart). A node that is switched off when the server restarts is still known by its address, so Studio's search for nodes in the network no longer offers the radar nodes that are already added; forgetting a node forgets its address too. A damaged entry of the file is dropped without losing the nodes.
- The firmware probe also returns the node's `kind` when the node says it (radar, solar, electrical, hmi), which Studio uses to keep each menu's search to its own kind of node. 262 tests.

## [0.5.0] - The voice commands that ask, and the lights

- **`/api/v1/voice/command` carries out the ten new commands of the gateway** and answers in the language of the person: the active alarms (and how many are serious), the nodes online (and which are not), the cameras that answer (and which do not), the people the radars see, the solar system (panels, consumption, battery), what the house draws from the grid, the state of the internet and the devices of the network, the time, and a help that says what can be asked. *Lights on* and *lights off* send the command to every light of the house, name the ones that did not answer and are in the audit trail with the person. Nothing here reads more than the person could read in the console. 258 tests.

## [0.4.9] - The observation service's routes

- **`/api/v1/ai/...`** with its own token (`ARMOR_AI_TOKEN`, which opens these and nothing else - not even an operator's token does, and this one cannot arm or read anything): `context` (the mode, the radar nodes with their tracks and light, the cameras that can be looked at), `cameras/{id}/frame` (one 64 x 36 grey frame taken straight from the camera's stream with FFmpeg - its lighter sub-stream when it has one - never stored, and what goes wrong is told without the camera's address or password) and `observations` (movement seen: it raises a `camera_motion` alarm only while the system is armed, once until it is closed). The movement alarm is announced like the others, with its camera, to the notifications, Telegram and Home Assistant. 258 tests (5 new).

## [0.4.8] - Alarms to Telegram and Home Assistant

- **Telegram:** `ARMOR_TELEGRAM_BOT_TOKEN` and `ARMOR_TELEGRAM_CHAT_IDS` (one to ten chats, numbers or `@channel`) send every alarm to those chats through a bot of the installation. **Home Assistant:** `ARMOR_HOMEASSISTANT_URL` and `ARMOR_HOMEASSISTANT_WEBHOOK_ID` post the alarm (the same JSON as the webhook, plus `title` and `text`) to a webhook an automation of Home Assistant listens on. Both are tried again after 1, 4 and 15 seconds, a client error (a wrong token) is not retried, and every end is in the audit trail (`alert.telegram`, `alert.homeassistant`) without the token or the webhook id, which are also masked in the settings file.
- **The sentences** of Telegram and Home Assistant are told in `ARMOR_ALERT_LANGUAGE` (seven languages, Spanish by default): *ALERTA en el nodo nodo-radar-1: 3 personas detectadas con el sistema armado.*
- **`GET /api/v1/admin/notifications`** says which places are set up (never their secrets) and **`POST /api/v1/admin/notifications/test`** sends a test message to all of them, or to one, and says what each answered (administrators). The values are checked when the server starts. How to get the token, the chat id and the webhook id is in `docs/INTEGRATION.md`. 253 tests (6 new).

## [0.4.7] - The services list finds the voice gateway

- **Real bug, reported on the bench:** the list of services (Studio's Services menu and the phone's) looked for the voice gateway as `armor-voice-ai.service`, but the installer makes `armor-voice.service`, so it showed as not running while it was. The catalogue now names the unit the installer makes and its port (18090).

## [0.4.6] - Written and spoken commands

- **`POST /api/v1/voice/command`** (a signed-in operator): takes what the person said as text (`text`, at most 200 characters, `language` one of the seven, `confirmation` for the second turn), asks the voice gateway (`ARMOR_VOICE_URL` and `ARMOR_VOICE_TOKEN`; ARMOR-VOICE-AI, on this machine) which of its four closed commands it is, and carries out what is accepted with the session of the person: **arm** and **disarm** (they need a second turn with the confirmation token the first answer carries), the **status** (the mode, the active alarms and the nodes online, said in the person's language) and **silence** (acknowledges the active alarms). The answer says what was understood, whether it was carried out, what to say, and the token when one is needed. `GET /api/v1/voice/status` tells whether the gateway is set up. The audit trail holds the command and the person, never the words. Without a gateway the route says `voice_unavailable`; one that does not answer, `voice_not_answering`. 247 tests (4 new).

## [0.4.5] - How far each node is in a firmware update

- A firmware job now says, for every node, `progress` (0-100), `sent` and `total` (the bytes of the image that have gone out) and `waited_s` (the seconds since the node was told to restart). The image goes out as a stream that counts what has been taken, so the number moves while it is being sent.

## [0.4.4] - Firmware of the field nodes, updated from Studio

- **`/api/v1/admin/firmware/...` (administrators):** the server updates the firmware of field nodes - one, or every node of a kind (radar, solar, electrical, HMI) - one after another. The image is a file uploaded to the server (`uploads`, at most 4 MB, kept an hour) or the newest release of the node's repository on GitHub, downloaded here (following GitHub's redirect) and checked against the SHA-256 the release publishes in `<image>.sha256`; a release without it, or whose image does not match it, is never used. Each node is signed in to with the login of its own panel (given for the job, held only by the job and never written in the audit trail), sent the image on its own update route, and waited for until it answers again with the new version (the hash the node reports for what it received must be the one sent). `probe` asks nodes for their id, version and board; `jobs` starts a job and answers at once, `jobs/{id}` says how every node stands. Only local addresses are accepted. Works for every kind of node, also one with no route to the Internet. 243 tests (6 new).

## [0.4.3] - One failed pass of the clock no longer ends the server

- The 2-second pass that expires silent devices, nodes and sessions is wrapped: if one of its steps throws, the server logs `ARMOR_SWEEP=FAILED` once (and again after a pass that worked) and carries on, instead of ending the process with an uncaught exception.


## [0.4.2] - Administration from Studio, alarms that stay dealt with, and live video that keeps up

- **Real bug, found on the bench:** an alarm that somebody deleted (or that was cleared from the record) while its cause was still going on came straight back with the next report of the same condition. It is now kept quiet until the cause ends and happens again; an alarm that was only acknowledged was never duplicated.
- **Administration (administrators only, every action in the audit trail):** `/api/v1/admin/...` lists the A.R.M.O.R. services and starts, stops or restarts them; reads and writes their settings files (the value of every secret is hidden, and a hidden line keeps its real value when the file is saved); makes and removes the accounts of the MQTT broker (the password is shown once); and adopts a node in one step - makes its broker account and writes the broker and that account into the node's own panel with the node's login, which is used once and never kept. All of it goes through the admin agent of ARMOR-DEVOPS over a Unix socket (`ARMOR_ADMIN_SOCKET`, `ARMOR_ADMIN_TOKEN`); this server stays without privileges, and without the agent these routes answer that it is not installed.
- **Live video:** the live picture can use a lighter second stream of the camera (`previewPath`, filled in by *Discover streams* when the camera has one), and falls back to the main stream if that one gives nothing; the pictures a second and the width are settings (`ARMOR_LIVE_FPS`, default 12, and `ARMOR_LIVE_WIDTH`, default 960; a picture is never enlarged); and a viewer on a slow link is skipped instead of making the server keep every picture it could not send, which made the picture fall further and further behind.

## [0.4.1] - Preferences that follow the account

- **`GET`/`PUT /api/v1/preferences`:** language, theme and the saved weather place, kept per signed-in user (`data/preferences.json`). Added because Studio's own browser storage made these look reset every time someone reached the server from a different address - now the account's own choice, once saved, wins regardless of which network or IP was used.

## [0.4.0] - Live video that starts faster

- **Live video:** FFmpeg no longer spends seconds looking at the stream before it shows anything (a short probe and no input buffering), the pictures are 15 a second instead of 10, a viewer that joins gets the last picture of the camera at once instead of waiting for the next one, viewers only receive whole pictures, and a camera's relay stays warm after the last viewer leaves, so going to another menu and back does not start it over.
- **A stream address warms the camera:** asking for one (which Studio does for the cameras on screen and the ones next to the large view) starts the camera's relay ahead of its first viewer, and a relay stays a couple of minutes after the last one leaves.
- 2 new tests (229 in all).

## [0.3.9] - The services of the system, running or not

- **`GET /api/v1/system/services`:** every service of the system - the programs of the machine (the server, Studio, the MQTT broker, the network node, and the AI and voice services when they are installed), read from `systemctl show` (state, process, memory, restarts, when it started, whether it starts at boot), and the field nodes (radars and electrical nodes, online or not). A program that is not installed is listed as such; where there is no systemd the programs show as unknown. Read only.
- 6 new tests (227 in all).

## [0.3.8] - Logins kept for the devices of the network
- Documentation: the seven READMEs describe the machine metrics, the connection settings, the panel summary and the device logins.

- **`PUT/DELETE /api/v1/network/devices/:id/login`** (administrators only): the user and password of a device's web administration are kept encrypted (AES-256-GCM) and never sent back; device listings only say whether there is a login and its user.
- **`inspect` order:** the login travels only inside the answer to the node that must use it, once, and the order is refused (409) if none is kept.
- 3 new tests (221 in all).

## [0.3.7] - A summary for small screens

- **`GET /api/v1/panel/summary`.** A few hundred bytes for the screens that cannot take the whole state (the touch panel of ARMOR-HMI, a watch): the mode, the nodes online and the alarms that need a person, newest first and the ones nobody has acknowledged first, six at most. Any signed-in operator; it is in the OpenAPI description.
- A test of the route (it needs a sign-in, and an answer has only the fields the panel reads). 218 tests in all.
- The tests no longer carry a real public address: the examples of a public address use the documentation ranges.

## [0.3.6] - Address and ports from Studio

- **`GET/PUT /api/v1/system/connection` (administrator).** Where the server listens (address, port) and the port Studio is served on are saved in `connection.json` beside the data and win over the environment at the next start; a missing, broken or nonsensical file is ignored so a wrong value typed in a page can never stop the server from starting. The origin Studio is allowed from follows its new port. Refuses a non-loopback address while the administrator password is shorter than 12 characters.
- 3 new tests (217 in all).

## [0.3.5] - The machine, live

- **`GET /api/v1/system/metrics`.** How the computer the server runs on is doing, as a task manager shows it: processor use, load and clock, memory and swap, every temperature the board reports, the disks that hold files (told apart as card/eMMC, USB or SATA, and NVMe over PCIe), each network card with its link and traffic, and the last five minutes of it, sampled every two seconds. Read from `/proc` and `/sys` on Linux (the CM5 and the Jetson); anything else gets what Node can say, and what is not there is left out. Read only, for any signed-in operator.
- 6 new tests (214 in all): the readers of `/proc`, the kind of disk and the bounded history.

## [0.3.4] - Orders for the network node, devices to hide and to watch, the public address, cookies that cannot shadow each other

- **Manual orders for an ARMOR-NETWORK node.** `POST /api/v1/network/commands` queues a sweep now, a ping, a traceroute, a wake-up, a look at the ports or at the web page of one device; the node gets it in the answer to its next message (never over MQTT, each order handed out once, at most four at a time, forgotten after two minutes if not taken), does it and reports in `results`; `GET /api/v1/network/commands[/{id}]` shows the status and the result. Bounded, audited and rate limited; refused when the node is not reporting.
- **Devices can be hidden from the list and watched.** A device note gains `hidden` (left out of `GET /api/v1/network` unless `?hidden=1`, the count is told) and `watch` (an alarm `network_watched_online`, with the device's facts, the next time it comes onto the network; the watch is spent once it has told). Naming, hiding and watching are for any signed-in operator; marking a device as known stays an administrator's.
- **The public address.** The `public` block of a node (public address, provider, city, when it last changed) is accepted and served with the node, with the strict parser of ARMOR-COMMON 0.2.9.
- **Session cookies named by scheme.** A browser that once met the server over HTTPS keeps its Secure cookie for the host, and a page over plain HTTP is not allowed to replace a Secure cookie of the same name: after the HTTPS trial was undone the login seemed to work and then nothing stuck, and the Users tab did not recognise the administrator. The cookies are now `armor_studio_sid` / `armor_operator_sid` over HTTP and `__Host-armor_studio_sid` / `__Secure-armor_operator_sid` over HTTPS, so they cannot shadow each other (everyone signs in once more).
- 3 new tests (208 in all): the queue of orders, the round trip through the routes, hiding and watching.

## [0.3.3] - Sessions that last, versions of the designs, alarms that say what they are about

- **A signed-in console keeps its session.** A session in use is renewed once half of its life is gone (the cookie is set again with it), and the default life of a Studio session is 7 days instead of 8 hours (`ARMOR_STUDIO_SESSION_TTL_MS`, up to 30 days). One nobody uses still ends at its time. Found for real: the administrator kept losing the role in the Users tab.
- **Nothing a design held is lost to a later save.** Before a save changes the site, electrical or network design, the design as it was is kept as a version (at most one every five minutes, and always when the save takes a lot away): the latest 48 plus the last of each of the past 30 days, in `<file>.history/`. `GET .../versions` lists them and `GET .../versions/{id}` returns one whole, to be taken back by saving it as the current one.
- **Alarms carry the facts.** Every alarm of the network says which device (the name it was given, its address, MAC, maker, kind, open ports), which port opened and whether it is a risky one, which two MACs claim one address, and what the line was doing (latency, loss, which probes failed); the facts of an open alarm are kept up to date while it goes on.
- **A slow or lossy line is no longer an alarm for the first minutes.** `network_degraded` is raised once the line has been so for 3 minutes (it was raised the moment it flipped, 32 times in three days on a connection that was fine).
- **Alarms can be taken off the list.** `DELETE /api/v1/alarms/{id}` takes one away; `DELETE /api/v1/alarms` clears every alarm somebody has acknowledged, ended or not (it only took the ones both acknowledged and ended, so what was being lived with never went), and is the operator's to use (it was an administrator's and did nothing, without a word, when the role was missing).
- 9 new tests (205 in all).

## [0.3.2] - Native HTTPS/WSS, ported from HYDRA-UMC-SERVER

- **Real gap, found while investigating why the operator's phone and browser both refuse a public-IP connection:** this server only ever created a plain `http.Server` - `ARMOR-ANDROID-CONTROL`'s own client deliberately refuses to send its password over plain HTTP to anything outside a private LAN address, and reaching Studio from outside its default CORS allow-list needs a real origin added to `ARMOR_STUDIO_ORIGIN` either way. Neither app was wrong: this server genuinely had no way to serve real HTTPS.
- `TLS_CERT_PATH`/`TLS_KEY_PATH` now switch the shared REST + `/api/v1/events` WebSocket listener to `https.createServer()`/WSS, the same environment-variable convention HYDRA-UMC-SERVER's own already-real TLS support uses - off (today's plain HTTP) unless both are set. Stricter than that version in one way: setting only one of the two is a configuration error at start-up rather than a silent fallback to plain HTTP, so a typo'd variable name can never leave an operator believing the server is on HTTPS when it is not.
- Documented in all 7 README languages: how to get a real, publicly-trusted certificate via Let's Encrypt/Certbot for genuine remote access, and how this is independent of `ARMOR-DEVOPS`'s own Caddy-based `tls` Compose profile (a LAN-only, self-signed-CA alternative for whoever would rather not manage a certificate directly).
- **Tests:** 3 new (`tests/tls.test.ts`) - both variables must be set together, a path that does not exist is refused at configuration time, and a real self-signed certificate generated on the fly makes the shared listener genuinely answer over HTTPS. Never run yet with a real publicly-trusted certificate on real hardware.

## [0.3.1]

- A GitHub Actions CI baseline (`.github/workflows/ci.yml`): validates the manifest, the version, CHANGELOG.md's heading, the seven README translations' structure and its own local Markdown links, then runs this project's real build/test through `tools/armor_project_tool.py build-test .` (vendored from ARMOR-COMMON, alongside `tools/armor_ci_validate.py` and `tools/_armor_readme_parity.py`, which do the manifest/docs checking).

## [0.3.0] - The local network

- **The state of the network from the ARMOR-NETWORK nodes:** `POST /api/v1/network/state` (the ingest token) and the MQTT topic `armor/network/+/state` take the `network` message of ARMOR-COMMON 0.2.5, parsed strictly like the shared vectors say (a node that names another node in its body is refused, a device and an event are named once, an event names what it is about). The store keeps the latest state of every node (stale after ninety seconds without a message), a history of the internet (its state, latency and loss) and of the interface's traffic, the outages (kept in `network-outages.json`, so a restart does not forget them) and the latest events, told once each however many times a node repeats them; the backlog of a node the server has just met is history, not news.
- **What an operator reads and does:** `GET /api/v1/network` (the nodes with their devices, the sums, the events and the outages), `GET /api/v1/network/history`, and, for an administrator, `PUT` and `DELETE /api/v1/network/devices/{id}` to name a device, note something, give it a kind of its own and **mark it as known** (kept in `network-devices.json`; it ends the alarm of a new device). `GET` and `PUT /api/v1/network/design` keep the network drawing of Studio's Network Designer, versioned like the site and the electrical designs.
- **Alarms:** `network_internet_down` (high: the router answers and nothing beyond it does), `network_lan_down` (high: the router does not answer), `network_degraded`, `network_new_device` (a device nobody had marked as known), `network_arp_conflict` (high), `network_port_opened` (high for Telnet, FTP, remote desktop, VNC, a database, the provider's remote management or SMB; a warning for the rest) and `network_offline`. They end when their cause does (a port that closes, the device that goes away, the internet that returns, an operator marking a device as known). Automations can trigger on them (`source_type` `network`).
- 10 new tests (193 in all).

## [0.2.9] - The way to a switch, and off

- **`electrical_switching.ts`, the only code that can send anything towards mains equipment, and it is OFF.** `POST /api/v1/electrical/switch` (an administrator) takes `{node, switch, action}` (`arm`, `close_a`, `close_b`, `open`, `acknowledge`) and answers 202 with a command id; `GET /api/v1/electrical/switching` (an operator) says whether it is on, which commands wait for an answer and what became of the latest ones. It refuses (and audits every refusal) unless `ARMOR_ELECTRICAL_SWITCHING=1`, the node is not stale, says in its own reading that it may switch (`switching_enabled`) and has that switch, no fault is latched (except to `open` or `acknowledge`) and nothing else waits on that switch (`open` never waits). A close only follows an arm the node accepted and carries the one-time token the node gave then: the token stays in the server and appears in no response, audit line or log.
- The command goes to `armor/electrical/{node}/command` (never retained, at most once); the node's answer (`.../result`, subscribed) is matched to a command that is waiting, and one that matches nothing is dropped and audited. No answer in five seconds is recorded as `timeout`. With no broker the command is not sent (503).
- The strict parsers of the state message (`switches`, up to four, each once), of a command and of an answer implement the new ARMOR-COMMON 0.2.4 schemas, and the 266 shared vectors pass. The alarm `electrical_switch_fault` (high) rises for a latched fault or both contacts closed and ends when the node says it is gone.
- Off by default at three places: this server (`ARMOR_ELECTRICAL_SWITCHING`, with a start-up warning when on), the node (`switching_enabled`) and the broker's ACL. Nothing that switches has been built; the 14 new tests use answers made by the tests.

## [0.2.8] - The optional fields of the inverter message

- **Alarms for the electrical nodes:** a meter's own alarm (`electrical_alarm`), the mains out of range on an AC channel (`electrical_voltage`, below 195 V or above 253 V, ending inside 200 to 250 V), the grid lost (`electrical_grid_lost`, the channel called `grid` below 50 V, ending at 100 V) and a node that went silent (`electrical_offline`). None depends on the security mode; the notifier announces them like the solar ones. 169 tests.
- The strict parser of the inverter message accepts the optional second PV input and the units of a parallel system of ARMOR-COMMON 0.2.3 (and the shared vectors, 193 now, pass).


## [0.2.7] - The electrical design is kept on the server

- `GET` and `PUT /api/v1/electrical/design`: the house's electrical diagram drawn in Studio's Electrical Designer, kept in its own file (`electrical.json`), apart from the site design. Same rules as the site design: an operator's route, up to 768 kB, versioned, and a save made from an out-of-date copy is refused with the current one (409) instead of overwriting it; every accepted save is in the audit trail. The server does not interpret the drawing.
- **Readings of the ARMOR-ELECTRICAL nodes.** `POST /api/v1/electrical/readings` (the ingest token) and the MQTT topic `armor/electrical/+/state` take the `electrical` message, parsed strictly like the shared vectors say (a node that names another node in its body is refused); `GET /api/v1/electrical/readings` gives an operator the latest reading of every node and the sums (grid power and energy, alarms), `GET /api/v1/electrical/history` the recent samples of a channel. A node silent for a minute is stale and counts for nothing. Reading only: no route sends anything to a node.

## [0.2.6] - A catalogue of inverters and batteries

- The solar catalogue lists the inverter families the reference projects name (Axpert VM II / VM III / MKS / MKS IV / King, MPP Solar PIP MS / HS / GK, EASun iSolar, Must PV18 / PH18, Revo VM III, InfiniSolar V, LV5048, SunGoldPower) with the **serial dialect** each answers in (`inverter_dialects`: auto, pi30, revo or pi18), the Pylontech models (US2000, US2000C, US2000B Plus, US2KBPL, US3000, US3000C, US5000, UP2500, UP5000, Force L1 and L2), the Pytes E-Box and **96 ANT-BMS presets** (`ant-bms-<cells>s-<amps>a`: 4 to 32 cells by 40 to 300 A).
- Any ANT-BMS combination inside the limits (4 to 32 cells, 20 to 500 A) can be declared even when it is not a preset; anything else is refused. The catalogue also gives the name of every model (`labels`; "other" is worded by each client in its language) so a client that does not know a model can still show it.
- The example readings follow the model: an ANT-BMS shows as many cells as its name says.
- The battery message carries `health_percent` (the capacity a battery has learned against its rated one) on the stack and on each module, checked like the rest against the shared vectors; the example readings have it.

## [0.2.5] - Solar alarms reach the phone and the webhook

- **A solar alarm is announced like a device alarm:** the outbound message (`alarm.raised`) now also goes out for an alarm raised by solar equipment (an inverter fault, a battery that is low or protecting itself, equipment that went silent), with `solar_id` (`node/device`) where a device alarm has `device_id`, the severity and the code. It is sent once, when the alarm is raised, whether or not the system is armed; acknowledging or clearing it sends nothing. The Android app announces the same alarms from the history (ARMOR-ANDROID-CONTROL 0.3.0).
- Tests: 162 (was 161).

## [0.2.4] - Declaring solar equipment and trying the menus

- **An operator can declare an inverter or a battery stack** (name, model of the Voltronic, MPP Solar, Pylontech US2000 / US3000 / US5000 and ANT-BMS families, connection RS232 / RS485 / USB / CAN / Wi-Fi, gateway node, notes) from Studio; the declaration is kept in `solar-devices.json`, survives a restart and shows as *waiting* until the gateway node sends the first real reading, which fills it in.
- **Example readings:** one call makes a plausible reading of a declared device (a battery with its modules, cells and capacities according to its model) so the menus can be tried before any gateway exists. It is marked as an example, raises no alarm and is replaced, history included, by the first real reading.
- Tests: 161.

## [0.2.3] - Solar inverters and batteries

- **`POST /api/v1/solar`** (an ingest token) and the topic `armor/solar/#` take the messages of a gateway node, validated by the shared contract; **`GET /api/v1/solar`** gives the latest reading of every device, marked stale after two minutes without news, and the totals (panel and load power, battery power, charge, remaining and full capacity in Ah, energy in kWh); **`GET /api/v1/solar/history`** gives a series (a sample every 30 s, up to a day).
- **Four alarms:** an inverter in fault, a battery that is low, a battery in alarm and a solar device that stops answering; they are confirmed like any other alarm and appear in the history.
- Tests: 159, including the conformance vectors of both messages and every route in the OpenAPI file.

## [0.2.2] - The states of the field nodes' devices, checked with what their firmware writes

- New tests run the device states that an ARMOR-RADAR node publishes (a presence sensor with its distance, mapped pins, numbers), exactly as its firmware writes them (`tests/fixtures/firmware_device_states.txt`, generated by the firmware's own test program), through the device layer: somebody there triggers a motion device, nobody clears it, the distance is dropped as a non-state field, and the pin reports land on the fields they name. 151 tests (was 148). No change to the server itself.

## [0.2.1] - The address of a node's own panel

- The server listens to `armor/node/+/info` and keeps, beside each node, the name, firmware, address and port the node said (`panel` in the node state, null until it has). It is validated by the shared contract (conformance vectors, one of them per rule), it never makes a node appear by itself, it is not written to disk (the node repeats it every minute), a repeated message spends no revision, and forgetting a node forgets it.
- Tests: 148 (was 145).

## [0.2.0] - Devices, alarms, automations, arm and disarm from the console, and the design kept on the server

- **Devices:** smoke, CO, gas and flood detectors, panic buttons, door and window contacts, motion, glass-break and vibration sensors, temperature, humidity and light sensors, smart plugs, lights and switches, sirens, locks and valves, over Wi-Fi, Zigbee, Bluetooth, Z-Wave, Thread, LoRa, 433 MHz or a wire. A device reports by MQTT (any topic under `armor/device/`, with a field map and an optional availability topic) or by an authenticated push; its state is normalised (`triggered`, `open`, `on`, `locked`, `tamper`, temperature, humidity, battery, power...). Commands go out by MQTT or by HTTP to an address on the local network only.
- **Alarms:** a smoke, CO, gas, flood or panic device raises an alarm at once; a door, window, motion, glass-break or vibration device raises one only while the system is armed. An alarm is raised, acknowledged by a person and cleared, with who and when; radar and camera problems use the same lifecycle. `/api/v1/alarms` lists, acknowledges one or all, and clears the record.
- **Automations:** when a device changes, an alarm is raised or the mode changes, and only in the chosen mode, switch devices on, off or toggle (optionally back after some seconds) and notify. At most six actions per rule and six runs a minute per rule, so a loop cannot flood a device.
- **Arm and disarm** from a signed-in Studio session (`POST /api/v1/mode`), audited with the user's name.
- **Site design on the server** (`GET` and `PUT /api/v1/site`): one design for every browser and the phone, versioned, and a save made from an out-of-date copy is refused with the newer version instead of overwriting it. Terrain, buildings, cameras, radars and the places of devices are stored; the server does not interpret them.
- **System and audit:** `GET /api/v1/system` (version, uptime, links, counts, storage) and, for an administrator, `GET /api/v1/audit`.
- 145 tests (was 132).

## [0.1.9] - Sessions that survive a restart and a console that is never rate limited by its own polling

- Studio sessions are kept in `sessions.json` (only a hash of each session id, never the cookie), so an update or a reboot no longer signs everyone out. A signed-out session stays signed out.
- The general rate limit (240 requests a minute) no longer applies to a signed-in operator: the console's own polling could use it up and get every request refused. Anonymous clients are still limited, and the sign-in route keeps its own limit.
- 132 tests (was 130).

## [0.1.8] - Studio users and the targets of each node

- **Users.** Studio sign-in is now a list of users kept in `users.json` (scrypt hashes, never a password): an administrator creates, renames, gives a new password or role to, and removes users; anyone signed in can change their own name and password with the current one. Roles are `admin` and `operator`. A changed password or role ends that user's other sessions at once; there is always one administrator. `ARMOR_STUDIO_USERNAME` / `ARMOR_STUDIO_PASSWORD` seed the first administrator; `ARMOR_STUDIO_RESET_PASSWORD=1` puts the configured password back on a forgotten one. New passwords need 12 characters (8 on a loopback-only server).
- Sessions carry the user they belong to; `GET /api/v1/studio/session` says who is signed in. Bearer tokens remain service credentials and do not qualify for user administration.
- The state of a node includes the targets of its latest report (position, speed, whether an ignore zone excludes it), so a client can draw them. They are not written to disk.
- 130 tests (was 118).

## [0.1.7] - Working PTZ, manageable history

- **PTZ told the truth:** an empty 200 or a web page used to count as a confirmed move, so a camera without PTZ looked as if it moved. Now only a camera's own confirmation counts (`[Succeed]` from a Hi3510 unit, an XML status from PSIA), and a failed move says why: the stored login was refused, the camera did not answer, or it accepts no PTZ command. A refused login no longer waits for a slow ONVIF attempt.
- **PTZ stops itself:** most cameras keep turning until told to stop, so every move schedules its own stop after 2.5 s (a client holding a button repeats the move); closing the server cancels pending stops. PTZ has its own rate budget (240 a minute) and only the start of a movement is audited, not every repeat.
- **History:** search by node or camera, filter by level and by time range, read oldest first, `GET /api/v1/history/summary` (totals and the last 24 hours) and `DELETE /api/v1/history` (all events, one type, or older than N days) which needs `confirm=delete`, is permanent, audited, reaches the rotated log files and never reuses event numbers. The browsing window is now 5000 events.
- 118 tests (was 107).

## [0.1.6] - Camera watchdog, own broker, sharper security

- **Camera watchdog:** every configured camera is probed (a plain TCP connection to its RTSP or ONVIF port, no credential) every `ARMOR_CAMERA_CHECK_S` seconds (default 20, 0 disables). A camera is offline after two consecutive failures. Changes are events (`type: camera`), an offline camera is an alarm while armed (`camera.offline`), and `GET /api/v1/camera-status` (operator) reports each camera.
- **Security:** `GET /api/v1/status` now needs an operator (a stranger on the network could learn whether the system was armed and where the targets were); `GET /api/v1/info` shows the mode and capabilities only to an operator.
- **Security:** the answer to a field node's HTTP ingest is now just `accepted` and the revision; it used to return the whole perimeter state to whoever held the ingest token.
- **Security:** over MQTT a node can no longer speak for another one: the `node_id` in the body must be the node of the topic it was published on (the broker ACL guarantees who published it).
- **Security:** at most 256 distinct nodes are accepted, so inventing node names cannot grow the state and its file without bound; `DELETE /api/v1/nodes/:id` forgets a decommissioned node (operator, audited).
- The ingest rate budget is 6000 requests a minute (three nodes at 10 Hz need about 1800).
- Load and chaos tests (seeded fuzzing of both contracts and of the HTTP ingest, a 1000-message burst from 40 nodes, random operations against the state invariants, crash and restart cases, an unreachable webhook under a flood); 107 tests.

## [0.1.5] - State that survives, an event history and alarm output

- **Persistence:** the security mode and the last observation of every node are written atomically to `data/state.json` (the mode at once, node data coalesced) and restored at start. A restart no longer disarms the perimeter; restored nodes are stale until they speak again. A damaged or foreign file is ignored, never trusted.
- **Event history:** every alert-level change, node status change (online, offline, silent) and mode change is recorded in `data/events.log` (rotated) and served, newest first and paged, by `GET /api/v1/history` (operator).
- **Alarm output:** `alert.raised`, `alert.cleared` and, while armed, `node.offline` / `node.stale` are published on MQTT `armor/server/alert` and POSTed to an optional webhook (`ARMOR_ALERT_WEBHOOK_URL`), signed with `X-Armor-Signature: sha256=HMAC` when `ARMOR_ALERT_WEBHOOK_SECRET` is set. Delivery never blocks ingestion, retries server errors with back-off, does not retry client errors, follows no redirect and is audited.
- **Alert rules:** `ARMOR_ALERT_DWELL_MS` (default 2000) is how long two targets must persist before the alert becomes high, and rectangular ignore zones (per node and sensor) exclude targets such as a road. `GET`/`PUT /api/v1/rules` are strictly validated, persisted in `data/rules.json` and audited.
- A time-driven sweep (every 2 s) makes silence and dwell time take effect without a message.
- Ingest has its own rate budget (1200/min) so a burst of node messages cannot lock an operator out.
- Removed the leftover Python server (`http_api.py`, `service.py`, `state.py`) and its tests; the end-to-end check now runs the real simulator against the real server.
- 91 tests (was 75).

## [0.1.4] - Modular server, security fixes and honest node state

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

## [0.1.3]

- Verified build completed; release version advanced from `0.1.2` to `0.1.3`.

## [0.1.2]

- Verified build completed; release version advanced from `0.1.1` to `0.1.2`.

## [0.1.1]

- Verified build completed; release version advanced from `0.1.0` to `0.1.1`.
- Fixed the standardized launcher so ignored local `.env` tokens reach the Node runtime even when an inherited shell variable is empty or a placeholder.
- Added loopback-only local camera-service discovery and accepted both local Studio origins (`127.0.0.1` and `localhost`) through CORS.
- Earlier work: Studio login endpoint with a dedicated HttpOnly session, real Hi3510/PSIA/ONVIF PTZ, JPEG snapshots and MP4 recordings, an evidence catalogue, RTSP path discovery and AES-256-GCM encrypted camera credentials.
