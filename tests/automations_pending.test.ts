import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AutomationEngine } from "../src/automations.js";
import { tempDir } from "./helpers.js";

test("a switch-back that was pending when the server stopped is done after the restart, not forgotten", async () => {
  const file = path.join(tempDir(), "automations.json");
  const ran: string[] = [];
  const options = { file, mode: () => "disarmed" as const, run: async (action: { type: string; device_id?: string; command?: string }) => { if (action.type === "device") ran.push(`${action.device_id}=${action.command}`); } };
  const first = new AutomationEngine(options as ConstructorParameters<typeof AutomationEngine>[0]);
  const created = first.create({ name: "siren for a while", enabled: true, trigger: { type: "mode", mode: "armed" }, when_mode: "any", actions: [{ type: "device", device_id: "siren-1", command: "on", for_s: 3600 }] });
  first.handleMode("armed");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(ran, ["siren-1=on"]);
  first.close();                                      // the server stops, with the siren still on
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { pending: Array<{ automation_id: string; device_id: string; command: string; due_ms: number }> };
  assert.deepEqual(saved.pending.map(item => [item.automation_id, item.device_id, item.command]), [[created.id, "siren-1", "off"]]);
  assert.ok(saved.pending[0].due_ms > Date.now() + 3_000_000);
  // the server comes back after the hour: the siren is switched off, at once
  saved.pending[0].due_ms = Date.now() - 5000;
  fs.writeFileSync(file, JSON.stringify(saved));
  const second = new AutomationEngine(options as ConstructorParameters<typeof AutomationEngine>[0]);
  second.resumePending();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.deepEqual(ran, ["siren-1=on", "siren-1=off"]);
  second.close();
  assert.deepEqual((JSON.parse(fs.readFileSync(file, "utf8")) as { pending: unknown[] }).pending, [], "and it is no longer pending");
});

test("a second trigger of an automation that switches back after a while moves the switch-back to later, so the first one cannot undo the new run", async () => {
  const file = path.join(tempDir(), "automations.json");
  const ran: string[] = [];
  const engine = new AutomationEngine({ file, mode: () => "disarmed" as const, run: async (action: { type: string; device_id?: string; command?: string }) => { if (action.type === "device") ran.push(`${action.device_id}=${action.command}`); return { ok: true }; } } as unknown as ConstructorParameters<typeof AutomationEngine>[0]);
  engine.create({ name: "light for a second", enabled: true, trigger: { type: "mode", mode: "armed" }, when_mode: "any", actions: [{ type: "device", device_id: "light-1", command: "on", for_s: 1 }] });
  engine.handleMode("armed");
  await new Promise(resolve => setTimeout(resolve, 600));
  engine.handleMode("disarmed");
  engine.handleMode("armed");                          // triggered again before the first switch-back was due
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(ran.filter(item => item === "light-1=off").length, 0, "the first switch-back (due about now) did not happen");
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal(ran.filter(item => item === "light-1=off").length, 1, "the new one did, once");
  engine.close();
});
