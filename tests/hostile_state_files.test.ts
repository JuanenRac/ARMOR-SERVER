// Every file the server keeps may be damaged, cut short, emptied or replaced by something of another shape (a full disk, a power cut, a hand edit): the server must still
// start, with that part empty, and must not take the others down with it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createArmorApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { SECRETS, tempDir } from "./helpers.js";

const FILES = [
  "alarm-zone-links.json", "alarm_design.json", "alarms.json", "arm-profiles.json", "automations.json", "camera-ignore-zones.json", "cameras.json", "capture-on-detect.json",
  "connections.json", "devices.json", "electrical.json", "energy-alarms.json", "fcm-devices.json", "known-nodes.json", "network-devices.json", "network-logins.json",
  "network-outages.json", "network.json", "node-life.json", "preferences.json", "rules.json", "sessions.json", "site.json", "solar-devices.json", "state.json", "totp.json", "users.json",
];
const HOSTILE = ["", "{", "null", "[]", "42", "\"text\"", "true", "{\"schema\":1,\"users\":null,\"alarms\":null,\"devices\":null,\"items\":null}", "{\"schema\":1,\"users\":[1,null,\"x\"],\"alarms\":[null],\"devices\":[null,5]}"];

const start = async (dir: string): Promise<void> => { const app = createArmorApp(readConfig({ ...SECRETS, ARMOR_DATA_DIR: dir }), "test"); await app.close(); };

for (const content of HOSTILE) {
  test(`the server starts when every state file holds ${JSON.stringify(content.slice(0, 40))}`, async () => {
    const dir = tempDir();
    for (const name of FILES) fs.writeFileSync(path.join(dir, name), content);
    fs.writeFileSync(path.join(dir, "events.log"), "{ not json\nnull\n[]\n");
    try { await start(dir); } catch {
      // name the file that does it
      const failures: string[] = [];
      for (const name of FILES) {
        const alone = tempDir();
        fs.writeFileSync(path.join(alone, name), content);
        try { await start(alone); } catch (error) { failures.push(`${name}: ${(error as Error).message}`); }
      }
      assert.deepEqual(failures, []);
      assert.fail("the server did not start with every file damaged, and no single file explains it");
    }
  });
}
