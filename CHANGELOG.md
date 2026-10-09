# Changelog

All notable changes to this project are documented here.

## [0.5.1] - A paused service says so

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
