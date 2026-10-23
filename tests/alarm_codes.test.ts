import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALARM_CODE_WORDS, alarmCodeWords } from "../src/alarm_codes.js";
import { ALERT_LANGUAGES, alertText } from "../src/alert_text.js";
import type { AlertMessage } from "../src/notify.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sharedFile = path.join(directory, "..", "..", "ARMOR-COMMON", "src", "armor_common", "alarm_codes.json");

test("the server's words for the codes are the shared table", { skip: fs.existsSync(sharedFile) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const shared = JSON.parse(fs.readFileSync(sharedFile, "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(ALARM_CODE_WORDS)), shared.codes);
  assert.deepEqual([...ALERT_LANGUAGES], shared.languages);
});

const base: AlertMessage = { service: "armor-server", event: "alarm.raised", at: "now", mode: "armed", severity: "high", code: "network_new_device", network_id: "net-1/aa:bb" };

test("an alarm is told with the words of its code in every language and never with the code", () => {
  for (const language of ALERT_LANGUAGES) {
    const text = alertText(base, language);
    assert.ok(text.includes(alarmCodeWords("network_new_device", language)), language);
    assert.ok(!text.includes("network_new_device"), language);
    assert.ok(text.includes("net-1/aa:bb"), language);
  }
});

test("an escalation carries the words as well, and a code nobody has described stays as it is", () => {
  const escalated = alertText({ ...base, event: "alarm.escalated", minutes: 7 }, "es");
  assert.ok(escalated.includes("Un dispositivo que nunca se había visto") || escalated.includes(alarmCodeWords("network_new_device", "es")));
  assert.ok(escalated.includes("7"));
  assert.ok(alertText({ ...base, code: "brand_new_code" }, "en").includes("brand_new_code"));
});
