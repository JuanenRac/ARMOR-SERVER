# Updating the firmware of the field nodes from Studio

Configuration > *Node firmware* of Studio (administrators) updates the nodes without opening the page of each one. The server does the work.

## What a release must carry

For a node to be updated from GitHub, the repository of its kind publishes a release (tag `vX.Y.Z`) with two files attached:

| Kind | Repository | Image | Its hash |
|---|---|---|---|
| radar | `JuanenRac/ARMOR-RADAR` | `armor_radar.bin` | `armor_radar.bin.sha256` |
| solar | `JuanenRac/ARMOR-SOLAR` | `armor_solar.bin` | `armor_solar.bin.sha256` |
| electrical | `JuanenRac/ARMOR-ELECTRICAL` | `armor_electrical.bin` | `armor_electrical.bin.sha256` |
| alarm | `JuanenRac/ARMOR-ALARM` | `armor_alarm.bin` | `armor_alarm.bin.sha256` |
| HMI | `JuanenRac/ARMOR-HMI` | `armor_hmi.bin` | `armor_hmi.bin.sha256` |

A kind that runs on more than one board publishes **one image per board**, named `armor_<kind>-<board>.bin` (`armor_alarm-s3-eth.bin`, `armor_alarm-s3-wifi.bin`), each with its own `.sha256`. The server asks every node which board it is (`GET /api/v1/session`) and takes the image built for it; the plain name is read only for the kind's default board (`s3-eth`, and `lcd7box` for the HMI), which is how a release made before the boards had a name in it still works. A job that mixes boards fetches one image per board, and a release without the image of a node's board is refused for that kind (`no_image_for_board`).

The image is the application image of the project (`build/<node>-<board>/armor_<kind>.bin`), not the merged one with the bootloader. The hash file is the line
`sha256sum armor_<kind>.bin` writes. A release without the hash file, or whose image does not match it, is never used.
Next to each image goes `<image>.sig2`: the Ed25519 signature (128 hex digits) of the manifest `armor-fw/1|<project>|<board>|<version>|<sha256>` made with the key of the A.R.M.O.R. releases (the one the nodes carry in `fw_trust.hpp`). The server checks it before it sends the image to any node, with the project written inside the image, the board of the file name and the version of the tag; a release without it, or signed by another key, is refused (`no_signature`, `bad_signature`). Only an image the administrator uploads by hand skips this: it is his own act.

## How a node is updated

1. The image is the uploaded file or the downloaded release (checked against its hash).
2. For every node, one at a time: it is asked who it is (`GET /api/v1/session`), signed in to with the login of its own panel, sent the image on `POST /api/v1/ota`
   (the route of the panel's own *Firmware* page) and waited for until it answers again with the version that route reported.
3. The hash the node says it received must be the one that was sent.

The login is given for the job, held only by it and never stored or written in the audit trail. Only local-network addresses are accepted. One job runs at a time.
A node whose new firmware does not start goes back to the previous one by itself (the boot loader does it), and shows as not having come back.

Routes: `POST /api/v1/admin/firmware/uploads` (raw `application/octet-stream`), `GET .../releases/{kind}`, `POST .../probe`, `POST .../jobs`, `GET .../jobs/{id}`.

## Controlling a node without opening its panel

Studio can restart, pause, put on standby, identify and read the diagnostics of a node, and put it in maintenance, through the server (see `docs/INTEGRATION.md` for the routes). A node that accepts this reads `armor/control/<node>/command` and `armor/control/all/command`, answers on `armor/control/<node>/result` and reports `control_state`, `control_since_ms`, `control_by`, `control_until_s`, `maintenance` and `maintenance_until_s` in its health report. Standby is the node's work switched off while it stays connected and keeps answering: it is not a power-off, it survives a restart and ends only with a resume. A pause ends by itself (60 to 3600 seconds). A node that installs a firmware, receives an upload, copies a slot or runs a battery operation refuses restart, pause and standby. The broker lets only the server publish orders (`scripts/mqtt_identity.sh node-control` adds the rules to a node installed before). Before it goes quiet on purpose (a restart, an update, a firmware upload, a pause, a standby) the node publishes the retained `node_maintenance` message to `armor/control/<node>/maintenance` (only its own topic) and clears it, retained too, when it is back; the server believes it only for the time the node expects or its own bound (`ARMOR_NODE_MAINTENANCE_MAX_S`, default 10 minutes), so a stuck node can not silence the alerts for ever.
