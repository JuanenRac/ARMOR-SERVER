// What the server does today with the summary of a day and the heat map switched off: the options that already exist keep their defaults, and asking for either report is answered 404 to
// everybody who may ask, whoever they are. These are written before the routes exist and must hold after.
import assert from "node:assert/strict";
import test from "node:test";
import { SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie } from "./helpers.js";

const EXISTING_DEFAULTS = {
  "alarm.disarm_pin": "if_set", "voice.silence_confirmation": "off", "alarm.arming_modes": false, "alarm.mode_downgrade_pin": "required", "alarm.mode_schedule": false, "alarm.mode_schedule_lowers": false,
  "alarm.mode_panel_sync": false, "alarm.config_hash": true, "server.zone_feed": true, "server.zone_feed_signature": true, "media.rtsp_proxy": true, "network.login_secure_only": false,
  "login.country_alert": true, "electrical.set_aside_old_readings": true, "voice.multipart_turn": true, "panel.live_events": true, "client.device_lock": "user", "nodes.nvs_encryption": "off",
  "voice.turn_max_bytes": 480_000, "voice.reply_audio_max_bytes": 200_000, "alarm_audio.spoken": false, "alarm_audio.custom_sounds": false,
};

test("the options that exist keep their defaults", () => {
  for (const [key, value] of Object.entries(EXISTING_DEFAULTS)) assert.equal((SECURITY_DEFAULTS as Record<string, unknown>)[key], value, key);
});

test("with the reports switched off nobody gets either of them", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    for (const route of ["/api/v1/summary/daily", "/api/v1/vision/heatmap"]) {
      assert.equal((await fetch(`${running.base}${route}`, { headers: { cookie: admin } })).status, 404, route);
    }
  } finally { await running.stop(); }
});
