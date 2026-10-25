# Routes of the server

Every route the code registers, with who may call it and the file that registers it. This table is generated from the code: change the code, not this file. A route marked `none here` answers whoever asks or checks the caller by itself (a node's token, a sign-in, a stream ticket); the contract of each one is in the OpenAPI description of ARMOR-COMMON.

| Method | Route | Who may call it | Registered in |
| --- | --- | --- | --- |
| PATCH | `/api/v1/account` | none here | `routes/users.ts` |
| PUT | `/api/v1/account/pin` | none here | `routes/users.ts` |
| GET | `/api/v1/admin/console` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/admin/console/jobs/:id` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/console/jobs/:id/cancel` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/console/lock` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/console/run` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/console/unlock` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/admin/files` | administrator | `routes/admin.ts` |
| GET | `/api/v1/admin/files/:id` | administrator | `routes/admin.ts` |
| PUT | `/api/v1/admin/files/:id` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/firmware/jobs` | administrator, fresh proof of identity | `routes/firmware.ts` |
| GET | `/api/v1/admin/firmware/jobs/:id` | administrator | `routes/firmware.ts` |
| POST | `/api/v1/admin/firmware/probe` | administrator | `routes/firmware.ts` |
| GET | `/api/v1/admin/firmware/releases/:kind` | administrator | `routes/firmware.ts` |
| POST | `/api/v1/admin/firmware/uploads` | administrator | `routes/firmware.ts` |
| GET | `/api/v1/admin/installation` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/installation` | administrator | `routes/admin.ts` |
| GET | `/api/v1/admin/maintenance/jobs/:id` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/admin/maintenance/status` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/admin/mqtt/accounts` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/mqtt/accounts` | administrator | `routes/admin.ts` |
| DELETE | `/api/v1/admin/mqtt/accounts/:user` | administrator | `routes/admin.ts` |
| GET | `/api/v1/admin/node-panels` | administrator | `node_panel_proxy.ts` |
| DELETE | `/api/v1/admin/node-panels/:id` | administrator, fresh proof of identity | `node_panel_proxy.ts` |
| PUT | `/api/v1/admin/node-panels/:id` | administrator, fresh proof of identity | `node_panel_proxy.ts` |
| POST | `/api/v1/admin/node-panels/:id/fingerprint` | administrator, fresh proof of identity | `node_panel_proxy.ts` |
| GET | `/api/v1/admin/nodes/:id/token` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/nodes/provision` | administrator | `routes/admin.ts` |
| GET | `/api/v1/admin/notifications` | administrator | `routes/notifications.ts` |
| POST | `/api/v1/admin/notifications/test` | administrator | `routes/notifications.ts` |
| GET | `/api/v1/admin/remote` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/remote/ddns/${action}` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| POST | `/api/v1/admin/remote/ddns/setup` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| GET | `/api/v1/admin/remote/tls` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/remote/wireguard/peers` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| DELETE | `/api/v1/admin/remote/wireguard/peers/:name` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| GET | `/api/v1/admin/remote/wireguard/peers/:name` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| POST | `/api/v1/admin/remote/wireguard/setup` | administrator, fresh proof of identity | `routes/maintenance.ts` |
| GET | `/api/v1/admin/services` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/services/:id/:action` | administrator | `routes/admin.ts` |
| GET | `/api/v1/admin/status` | administrator | `routes/admin.ts` |
| POST | `/api/v1/admin/system/${action}` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/admin/updates` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/updates` | administrator | `routes/maintenance.ts` |
| POST | `/api/v1/admin/updates/:id/rollback` | administrator | `routes/maintenance.ts` |
| DELETE | `/api/v1/admin/updates/history` | administrator | `routes/maintenance.ts` |
| GET | `/api/v1/ai/cameras/:id/frame` | AI service | `routes/ai.ts` |
| GET | `/api/v1/ai/context` | AI service | `routes/ai.ts` |
| POST | `/api/v1/ai/observations` | AI service | `routes/ai.ts` |
| POST | `/api/v1/alarm/command` | administrator | `routes/alarm.ts` |
| GET | `/api/v1/alarm/commands` | operator | `routes/alarm.ts` |
| GET | `/api/v1/alarm/design` | operator | `routes/alarm_design.ts` |
| PUT | `/api/v1/alarm/design` | operator | `routes/alarm_design.ts` |
| DELETE | `/api/v1/alarm/design/versions` | operator | `routes/alarm_design.ts` |
| GET | `/api/v1/alarm/design/versions` | operator | `routes/alarm_design.ts` |
| DELETE | `/api/v1/alarm/design/versions/:id` | operator | `routes/alarm_design.ts` |
| GET | `/api/v1/alarm/design/versions/:id` | operator | `routes/alarm_design.ts` |
| GET | `/api/v1/alarm/nodes` | operator | `routes/alarm.ts` |
| GET | `/api/v1/alarm/profiles` | operator | `routes/alarm_profiles.ts` |
| PUT | `/api/v1/alarm/profiles` | administrator | `routes/alarm_profiles.ts` |
| POST | `/api/v1/alarm/state` | none here | `routes/alarm.ts` |
| GET | `/api/v1/alarm/zone-feed/key/:node` | administrator, fresh proof of identity | `routes/security.ts` |
| GET | `/api/v1/alarm/zone-links` | operator | `routes/alarm.ts` |
| PUT | `/api/v1/alarm/zone-links` | administrator | `routes/alarm.ts` |
| DELETE | `/api/v1/alarms` | operator | `routes/alarms.ts` |
| GET | `/api/v1/alarms` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/alarms/:id` | operator | `routes/alarms.ts` |
| POST | `/api/v1/alarms/:id/acknowledge` | operator | `routes/alarms.ts` |
| POST | `/api/v1/alarms/acknowledge` | operator | `routes/alarms.ts` |
| GET | `/api/v1/audit` | administrator | `routes/system.ts` |
| GET | `/api/v1/automations` | operator | `routes/alarms.ts` |
| POST | `/api/v1/automations` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/automations/:id` | operator | `routes/alarms.ts` |
| PATCH | `/api/v1/automations/:id` | operator | `routes/alarms.ts` |
| POST | `/api/v1/automations/:id/run` | operator | `routes/alarms.ts` |
| GET | `/api/v1/camera-status` | operator | `routes/history.ts` |
| GET | `/api/v1/camera-views` | operator | `routes/cameras.ts` |
| GET | `/api/v1/cameras` | operator | `routes/cameras.ts` |
| DELETE | `/api/v1/cameras/:id` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/discover-rtsp` | operator | `routes/cameras.ts` |
| GET | `/api/v1/cameras/:id/ignore-zones` | operator | `routes/cameras.ts` |
| PUT | `/api/v1/cameras/:id/ignore-zones` | administrator | `routes/cameras.ts` |
| GET | `/api/v1/cameras/:id/mjpeg` | none here | `routes/cameras.ts` |
| GET | `/api/v1/cameras/:id/preview` | none here | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/preview-ticket` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/ptz` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/recordings/start` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/recordings/stop` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/snapshot` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/:id/stream-ticket` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/configure` | operator | `routes/cameras.ts` |
| POST | `/api/v1/cameras/discover` | operator | `routes/cameras.ts` |
| GET | `/api/v1/capture-settings` | operator | `routes/cameras.ts` |
| PUT | `/api/v1/capture-settings` | administrator | `routes/cameras.ts` |
| POST | `/api/v1/control/:mode` | none here | `routes/ingest.ts` |
| GET | `/api/v1/devices` | operator | `routes/devices.ts` |
| POST | `/api/v1/devices` | operator | `routes/devices.ts` |
| DELETE | `/api/v1/devices/:id` | operator | `routes/devices.ts` |
| PATCH | `/api/v1/devices/:id` | operator | `routes/devices.ts` |
| POST | `/api/v1/devices/:id/command` | operator | `routes/devices.ts` |
| POST | `/api/v1/devices/:id/state` | operator | `routes/devices.ts` |
| POST | `/api/v1/devices/state` | none here | `routes/devices.ts` |
| GET | `/api/v1/diagnostics/nodes` | none here | `routes/diagnostics.ts` |
| GET | `/api/v1/diagnostics/nodes/:id` | none here | `routes/diagnostics.ts` |
| GET | `/api/v1/diagnostics/nodes/:id/log` | none here | `routes/diagnostics.ts` |
| GET | `/api/v1/diagnostics/nodes/:id/package` | none here | `routes/diagnostics.ts` |
| GET | `/api/v1/diagnostics/tokens` | administrator | `routes/diagnostics.ts` |
| POST | `/api/v1/diagnostics/tokens` | administrator | `routes/diagnostics.ts` |
| DELETE | `/api/v1/diagnostics/tokens/:id` | administrator | `routes/diagnostics.ts` |
| GET | `/api/v1/electrical/design` | operator | `routes/alarms.ts` |
| PUT | `/api/v1/electrical/design` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/electrical/design/versions` | operator | `routes/alarms.ts` |
| GET | `/api/v1/electrical/design/versions` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/electrical/design/versions/:id` | operator | `routes/alarms.ts` |
| GET | `/api/v1/electrical/design/versions/:id` | operator | `routes/alarms.ts` |
| GET | `/api/v1/electrical/devices` | operator | `routes/electrical.ts` |
| GET | `/api/v1/electrical/energy` | operator | `routes/electrical.ts` |
| GET | `/api/v1/electrical/history` | operator | `routes/electrical.ts` |
| GET | `/api/v1/electrical/readings` | operator | `routes/electrical.ts` |
| POST | `/api/v1/electrical/readings` | none here | `routes/electrical.ts` |
| POST | `/api/v1/electrical/switch` | administrator | `routes/electrical.ts` |
| GET | `/api/v1/electrical/switching` | operator | `routes/electrical.ts` |
| POST | `/api/v1/health` | none here | `routes/ingest.ts` |
| DELETE | `/api/v1/history` | administrator | `routes/history.ts` |
| GET | `/api/v1/history` | operator | `routes/history.ts` |
| GET | `/api/v1/history/connections` | operator | `routes/history.ts` |
| GET | `/api/v1/history/summary` | operator | `routes/history.ts` |
| GET | `/api/v1/info` | none here | `routes/ingest.ts` |
| DELETE | `/api/v1/media` | administrator | `routes/media.ts` |
| GET | `/api/v1/media` | operator | `routes/media.ts` |
| DELETE | `/api/v1/media/:cameraId/:kind/:file` | operator | `routes/media.ts` |
| GET | `/api/v1/media/:cameraId/:kind/:file` | operator | `routes/media.ts` |
| GET | `/api/v1/media/:cameraId/:kind/:file/proof` | operator | `routes/media.ts` |
| PUT | `/api/v1/media/:cameraId/:kind/:file/protected` | operator | `routes/media.ts` |
| GET | `/api/v1/media/:cameraId/:kind/:file/sha256` | operator | `routes/media.ts` |
| POST | `/api/v1/media/proof/verify` | operator | `routes/media.ts` |
| POST | `/api/v1/mode` | operator | `routes/alarms.ts` |
| GET | `/api/v1/network` | operator | `routes/network.ts` |
| GET | `/api/v1/network/commands` | operator | `routes/network.ts` |
| POST | `/api/v1/network/commands` | operator | `routes/network.ts` |
| GET | `/api/v1/network/commands/:id` | operator | `routes/network.ts` |
| GET | `/api/v1/network/design` | operator | `routes/network.ts` |
| PUT | `/api/v1/network/design` | operator | `routes/network.ts` |
| DELETE | `/api/v1/network/design/versions` | operator | `routes/network.ts` |
| GET | `/api/v1/network/design/versions` | operator | `routes/network.ts` |
| DELETE | `/api/v1/network/design/versions/:id` | operator | `routes/network.ts` |
| GET | `/api/v1/network/design/versions/:id` | operator | `routes/network.ts` |
| DELETE | `/api/v1/network/devices/:id` | administrator | `routes/network.ts` |
| PUT | `/api/v1/network/devices/:id` | operator | `routes/network.ts` |
| DELETE | `/api/v1/network/devices/:id/login` | administrator | `routes/network.ts` |
| PUT | `/api/v1/network/devices/:id/login` | administrator | `routes/network.ts` |
| GET | `/api/v1/network/history` | operator | `routes/network.ts` |
| POST | `/api/v1/network/state` | none here | `routes/network.ts` |
| GET | `/api/v1/node-health` | operator | `routes/node_health.ts` |
| POST | `/api/v1/node-health` | none here | `routes/node_health.ts` |
| DELETE | `/api/v1/node-health/:id` | administrator | `routes/node_health.ts` |
| GET | `/api/v1/node-health/:id` | operator | `routes/node_health.ts` |
| DELETE | `/api/v1/nodes/:id` | operator | `routes/history.ts` |
| POST | `/api/v1/nodes/:id/control` | administrator | `routes/node_control.ts` |
| GET | `/api/v1/nodes/:id/diagnostics` | administrator | `routes/diagnostics.ts` |
| GET | `/api/v1/nodes/:id/diagnostics/log` | administrator | `routes/diagnostics.ts` |
| GET | `/api/v1/nodes/:id/diagnostics/package` | administrator | `routes/diagnostics.ts` |
| POST | `/api/v1/nodes/control` | administrator | `routes/node_control.ts` |
| GET | `/api/v1/nodes/control/operations` | administrator | `routes/node_control.ts` |
| GET | `/api/v1/nodes/control/operations/:id` | administrator | `routes/node_control.ts` |
| GET | `/api/v1/nodes/maintenance` | operator | `routes/node_control.ts` |
| DELETE | `/api/v1/operator/session` | operator | `routes/sessions.ts` |
| POST | `/api/v1/operator/session` | none here | `routes/sessions.ts` |
| GET | `/api/v1/panel/summary` | operator | `routes/system.ts` |
| GET | `/api/v1/preferences` | none here | `routes/preferences.ts` |
| PUT | `/api/v1/preferences` | none here | `routes/preferences.ts` |
| GET | `/api/v1/preflight` | operator | `routes/system.ts` |
| DELETE | `/api/v1/push/register` | operator | `routes/push.ts` |
| POST | `/api/v1/push/register` | operator | `routes/push.ts` |
| GET | `/api/v1/push/status` | administrator | `routes/push.ts` |
| POST | `/api/v1/push/unregister` | operator | `routes/push.ts` |
| GET | `/api/v1/radar/events` | operator | `routes/node_health.ts` |
| GET | `/api/v1/remote/check` | administrator | `routes/sessions.ts` |
| GET | `/api/v1/rules` | operator | `routes/history.ts` |
| PUT | `/api/v1/rules` | operator | `routes/history.ts` |
| GET | `/api/v1/security/settings` | administrator | `routes/security.ts` |
| PUT | `/api/v1/security/settings` | administrator, fresh proof of identity | `routes/security.ts` |
| GET | `/api/v1/site` | operator | `routes/alarms.ts` |
| PUT | `/api/v1/site` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/site/versions` | operator | `routes/alarms.ts` |
| GET | `/api/v1/site/versions` | operator | `routes/alarms.ts` |
| DELETE | `/api/v1/site/versions/:id` | operator | `routes/alarms.ts` |
| GET | `/api/v1/site/versions/:id` | operator | `routes/alarms.ts` |
| GET | `/api/v1/solar` | operator | `routes/solar.ts` |
| POST | `/api/v1/solar` | none here | `routes/solar.ts` |
| GET | `/api/v1/solar/alarms` | operator | `routes/solar.ts` |
| PUT | `/api/v1/solar/alarms` | operator | `routes/solar.ts` |
| GET | `/api/v1/solar/battery-ops` | administrator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/battery-ops` | administrator | `routes/battery_ops.ts` |
| GET | `/api/v1/solar/battery-ops/:id` | administrator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/battery-ops/:id/cancel` | administrator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/battery-ops/:id/execute` | administrator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/battery-ops/:id/restore` | administrator | `routes/battery_ops.ts` |
| GET | `/api/v1/solar/battery-ops/catalog` | operator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/battery-ops/images` | administrator | `routes/battery_ops.ts` |
| POST | `/api/v1/solar/devices` | operator | `routes/solar.ts` |
| DELETE | `/api/v1/solar/devices/:node/:device` | operator | `routes/solar.ts` |
| DELETE | `/api/v1/solar/devices/:node/:device/example` | operator | `routes/solar.ts` |
| POST | `/api/v1/solar/devices/:node/:device/example` | operator | `routes/solar.ts` |
| GET | `/api/v1/solar/energy` | operator | `routes/solar.ts` |
| DELETE | `/api/v1/solar/examples` | operator | `routes/solar.ts` |
| GET | `/api/v1/solar/history` | operator | `routes/solar.ts` |
| GET | `/api/v1/status` | operator | `routes/ingest.ts` |
| POST | `/api/v1/studio/elevate` | signed-in user | `routes/sessions.ts` |
| DELETE | `/api/v1/studio/session` | none here | `routes/sessions.ts` |
| GET | `/api/v1/studio/session` | none here | `routes/sessions.ts` |
| POST | `/api/v1/studio/session` | none here | `routes/sessions.ts` |
| POST | `/api/v1/studio/session/totp` | none here | `routes/sessions.ts` |
| GET | `/api/v1/studio/sessions` | signed-in user | `routes/sessions.ts` |
| DELETE | `/api/v1/studio/sessions/:id` | signed-in user | `routes/sessions.ts` |
| POST | `/api/v1/studio/sessions/end-others` | signed-in user | `routes/sessions.ts` |
| DELETE | `/api/v1/studio/totp` | signed-in user | `routes/sessions.ts` |
| GET | `/api/v1/studio/totp` | signed-in user | `routes/sessions.ts` |
| POST | `/api/v1/studio/totp/enable` | signed-in user | `routes/sessions.ts` |
| POST | `/api/v1/studio/totp/setup` | signed-in user | `routes/sessions.ts` |
| GET | `/api/v1/system` | operator | `routes/system.ts` |
| GET | `/api/v1/system/connection` | administrator | `routes/system.ts` |
| PUT | `/api/v1/system/connection` | administrator | `routes/system.ts` |
| GET | `/api/v1/system/ingest` | operator | `routes/system.ts` |
| GET | `/api/v1/system/metrics` | operator | `routes/system.ts` |
| GET | `/api/v1/system/services` | operator | `routes/system.ts` |
| POST | `/api/v1/telemetry` | none here | `routes/ingest.ts` |
| GET | `/api/v1/users` | administrator | `routes/users.ts` |
| POST | `/api/v1/users` | administrator, fresh proof of identity | `routes/users.ts` |
| DELETE | `/api/v1/users/:id` | administrator, fresh proof of identity | `routes/users.ts` |
| PATCH | `/api/v1/users/:id` | administrator, fresh proof of identity | `routes/users.ts` |
| DELETE | `/api/v1/users/:id/pin` | administrator, fresh proof of identity | `routes/users.ts` |
| PUT | `/api/v1/users/:id/pin` | administrator, fresh proof of identity | `routes/users.ts` |
| DELETE | `/api/v1/users/:id/totp` | administrator, fresh proof of identity | `routes/sessions.ts` |
| POST | `/api/v1/voice/command` | operator | `routes/voice.ts` |
| GET | `/api/v1/voice/status` | operator | `routes/voice.ts` |
| POST | `/api/v1/voice/turn` | none here | `routes/voice.ts` |
| POST | `/api/v1/voice/v1/turn` | none here | `routes/voice.ts` |
| GET | `/healthz` | none here | `routes/ingest.ts` |
