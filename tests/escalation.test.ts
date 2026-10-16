import assert from "node:assert/strict";
import test from "node:test";
import { Escalator } from "../src/escalation.js";
import type { Alarm } from "../src/alarms.js";
import type { AlertMessage } from "../src/notify.js";
import { alertText } from "../src/alert_text.js";

const alarm = (patch: Partial<Alarm>): Alarm => ({ id: "a1", key: "k", source: { type: "device", id: "smoke-1" }, severity: "critical", code: "smoke", raised_at: "2000-01-01T00:00:00.000Z", ...patch });

test("a critical alarm nobody acknowledged is told again once after the wait, and not before", () => {
  let now = Date.parse("2000-01-01T00:05:00.000Z");
  const sent: AlertMessage[] = [];
  const list: Alarm[] = [alarm({}), alarm({ id: "a2", severity: "warning" }), alarm({ id: "a3", acknowledged_at: "2000-01-01T00:01:00.000Z" })];
  const escalator = new Escalator({ afterMin: 10, active: () => list, send: message => sent.push(message), mode: () => "armed", now: () => now });
  assert.equal(escalator.tick(), 0);                                   // only five minutes
  now = Date.parse("2000-01-01T00:11:00.000Z");
  assert.equal(escalator.tick(), 1);                                   // the critical unseen one; not the warning, not the acknowledged one
  assert.equal(escalator.tick(), 0);                                   // once
  assert.equal(sent[0].event, "alarm.escalated");
  assert.equal(sent[0].minutes, 11);
  assert.equal(sent[0].device_id, "smoke-1");
  assert.match(alertText(sent[0], "en"), /NOBODY HAS ACKNOWLEDGED IT after 11 min/);
  assert.match(alertText(sent[0], "es"), /NADIE LA HA RECONOCIDO tras 11 min/);
});

test("with the wait at zero nothing is ever escalated", () => {
  const sent: AlertMessage[] = [];
  const escalator = new Escalator({ afterMin: 0, active: () => [alarm({})], send: message => sent.push(message), mode: () => "armed" });
  assert.equal(escalator.tick(), 0);
  assert.deepEqual(sent, []);
});
