/**
 * The token for the vision service never goes in clear to another machine: with the service allowed to be remote and a token held, a plain-http address
 * of a host that is not this machine is refused when it is saved, and a request to such an address (saved before the rule) never leaves. Loopback stays plain http.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { heatmap } from "../src/reports.js";
import { SecuritySettings, SecuritySettingsInvalid, visionTokenInClear } from "../src/security_settings.js";
import { tempDir } from "./helpers.js";

const settingsWith = (tokenHeld: boolean) => new SecuritySettings(path.join(tempDir(), "s.json"), { environment: () => (tokenHeld ? { "vision.service_token_set": true } : {}) });

test("the rule: only a remote service, with a token held, at plain http on another machine is a token in clear", () => {
  assert.equal(visionTokenInClear(true, true, "http://192.168.0.50:8765"), true);
  assert.equal(visionTokenInClear(true, true, "http://vision.example.org"), true);
  for (const [remote, held, url, why] of [
    [true, true, "https://192.168.0.50:8765", "https is the way"],
    [true, true, "http://127.0.0.1:8765", "this machine"],
    [true, true, "http://localhost:8765", "this machine"],
    [true, true, "http://[::1]:8765", "this machine"],
    [true, false, "http://192.168.0.50:8765", "no token to leak"],
    [false, true, "http://192.168.0.50:8765", "the remote switch is off: the request never leaves anyway"],
    [true, true, "", "no address"],
    [true, true, "not an address", "not an address"],
  ] as const) assert.equal(visionTokenInClear(remote, held, url), false, why);
});

test("saving: http to another machine is refused when the token would travel, and the setting stays as it was", () => {
  const settings = settingsWith(true);
  settings.update({ "vision.service_remote": true });
  assert.throws(() => settings.update({ "vision.service_url": "http://192.168.0.50:8765" }), (error: unknown) => error instanceof SecuritySettingsInvalid && error.key === "vision.service_url" && /https/.test(error.message));
  assert.equal(settings.get("vision.service_url"), "");
  settings.update({ "vision.service_url": "https://192.168.0.50:8765" });
  assert.equal(settings.get("vision.service_url"), "https://192.168.0.50:8765");
  settings.update({ "vision.service_url": "http://127.0.0.1:8765" });
  assert.equal(settings.get("vision.service_url"), "http://127.0.0.1:8765");
});

test("saving: the order of the changes does not matter - turning the remote switch on with a plain-http address already saved is refused too", () => {
  const settings = settingsWith(true);
  settings.update({ "vision.service_url": "http://192.168.0.50:8765" });   // fine while the switch is off: nothing leaves
  assert.throws(() => settings.update({ "vision.service_remote": true }), SecuritySettingsInvalid);
  assert.equal(settings.get("vision.service_remote"), false);
  assert.throws(() => settings.update({ "vision.service_remote": true, "vision.service_url": "http://192.168.0.50:8765" }), SecuritySettingsInvalid);
  settings.update({ "vision.service_remote": true, "vision.service_url": "https://192.168.0.50:8765" });
  assert.equal(settings.get("vision.service_remote"), true);
});

test("saving: with no token held, plain http to another machine is still allowed (nothing secret travels) and an unrelated change is never blocked", () => {
  const settings = settingsWith(false);
  settings.update({ "vision.service_remote": true, "vision.service_url": "http://192.168.0.50:8765" });
  assert.equal(settings.get("vision.service_url"), "http://192.168.0.50:8765");
  settings.update({ "summary.log_days": 20 });
});

const MAP = { schema: "armor.vision.heatmap/v1", camera_id: "cam-front", cols: 2, rows: 1, accepted_positions: 1, rejected_positions: 0, total: 1, max: 1, weights: [[1, 0]], normalized: [[1, 0]], contains_images: false };
const answer = () => ({ status: 200, type: "application/json", body: Buffer.from(JSON.stringify(MAP)) });

test("asking: a token is never sent in clear to another machine, even for an address saved before the rule", async () => {
  const asked: Array<{ url: string; token: string | undefined }> = [];
  const fetchVision = async (url: string, _ms: number, _max: number, token?: string) => { asked.push({ url, token }); return answer(); };
  const query = { format: "json", scale: "8" };
  const refused = await heatmap({ url: "http://192.168.0.50:8765", remote: true, fetch: fetchVision, token: "secret-token-0123456789" }, query);
  assert.equal(refused.status, 503);
  assert.equal(asked.length, 0, "the request did not leave");
  for (const [url, token] of [["https://192.168.0.50:8765", "secret-token-0123456789"], ["http://127.0.0.1:8765", "secret-token-0123456789"], ["http://192.168.0.50:8765", undefined]] as const) {
    const reply = await heatmap({ url, remote: true, fetch: fetchVision, token }, query);
    assert.equal(reply.status, 200, `${url} ${token ? "with" : "without"} a token`);
  }
  assert.equal(asked.length, 3);
  assert.equal(asked[0]!.token, "secret-token-0123456789");
});
