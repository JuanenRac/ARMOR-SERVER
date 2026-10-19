// Writing to a Pylontech battery: the shared vectors, the table, every refusal of the service, the one-time token, the staging of a firmware image, the history and the routes (off by
// default, always behind a fresh proof). No node that writes to a battery exists in these tests: its answers are made here.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { BATTERY_CATALOG } from "../src/battery_catalog.js";
import { batteryTopic, crc32, describeImage, differences, expertLine, outputBefore, parseBatteryCommand, parseBatteryResult, validateBatteryParams, BatteryOpsError, type BatteryResult } from "../src/battery_ops.js";
import { BatteryWriteService } from "../src/battery_write.js";
import { SolarStore, type SolarBattery } from "../src/solar.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const vectors = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;
const skip = fs.existsSync(path.join(directory, "solar_battery_command.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

for (const [kind, parse] of [["solar_battery_command", parseBatteryCommand], ["solar_battery_result", parseBatteryResult]] as const) {
  test(`${kind} parsing agrees with every shared conformance vector`, { skip }, () => {
    const all = vectors(kind);
    assert.ok(all.length >= 40);
    for (const vector of all) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `should reject: ${vector.name}`);
    }
  });
}

test("the server's table is the shared table", { skip: fs.existsSync(path.join(directory, "..", "src", "armor_common", "battery_ops.json")) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const shared = JSON.parse(fs.readFileSync(path.join(directory, "..", "src", "armor_common", "battery_ops.json"), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(BATTERY_CATALOG)), shared);
});

test("the topics of an order and of an answer name a node and nothing else", () => {
  assert.equal(batteryTopic("armor/solar/solar-1/maintenance/command", "command"), "solar-1");
  assert.equal(batteryTopic("armor/solar/solar-1/maintenance/result", "result"), "solar-1");
  for (const topic of ["armor/solar/solar-1/maintenance/state", "armor/solar/solar-1/pack/command", "armor/solar/Solar/maintenance/command", "armor/solar/maintenance/command", "armor/electrical/solar-1/maintenance/command"]) assert.equal(batteryTopic(topic, "command"), undefined, topic);
  assert.equal(batteryTopic("armor/solar/solar-1/maintenance/command", "result"), undefined);
});

test("the values of an operation are checked against the table", () => {
  const code = (op: string, params: unknown): string | undefined => { try { validateBatteryParams(op, params); } catch (error) { return error instanceof BatteryOpsError ? error.code : "other"; } return undefined; };
  assert.equal(code("set_clock", {}), undefined);
  assert.equal(code("set_clock", { hour: 1 }), "invalid_params");
  assert.equal(code("nothing", {}), "invalid_request");
  assert.equal(code("output_set", { output: "cfet", state: "off" }), undefined);
  assert.equal(code("output_set", { output: "mostest", state: "on" }), "invalid_params");
  assert.equal(code("output_set", { output: "cfet" }), "invalid_params");
  assert.equal(code("clear_data", { which: "all" }), "invalid_params");
  const module = { pov: 58000, povr: 55000, phv: 57600, phvr: 55500, plv: 47000, plvr: 48000, puv: 44000, puvr: 45000, pslp: 42000 };
  assert.equal(code("limits_set", { group: "module_voltage", values: module }), undefined);
  assert.equal(code("limits_set", { group: "module_voltage", values: { ...module, pov: 65001 } }), "invalid_params");
  assert.equal(code("limits_set", { group: "module_voltage", values: { ...module, pslp: 19999 } }), "invalid_params");
  assert.equal(code("limits_set", { group: "module_voltage", values: { ...module, pov: 50000 } }), "invalid_params");     // below the high-voltage alarm
  assert.equal(code("limits_set", { group: "module_voltage", values: { ...module, pov: 58000.5 } }), "invalid_params");
  const { pslp: _left, ...partial } = module;
  assert.equal(code("limits_set", { group: "module_voltage", values: partial }), "invalid_params");                      // whole groups only
  assert.equal(code("limits_set", { group: "current", values: {} }), "invalid_params");
  assert.equal(code("protections_set", { items: { bov: "en" } }), undefined);
  assert.equal(code("protections_set", { items: { bov: "dis" } }), "invalid_params");
  assert.equal(code("protections_set", { items: { bov: "dis" }, accept_risk: true }), undefined);
  assert.equal(code("protections_set", { items: { nope: "en" } }), "invalid_params");
  assert.equal(code("write_barcode", { serial: "H221014C32213244" }), undefined);
  assert.equal(code("write_barcode", { serial: "short" }), "invalid_params");
  assert.equal(code("firmware_update", { image_size: 200000, image_crc32: 1, image_version: "2.4" }), undefined);
  assert.equal(code("firmware_update", { image_size: 1000, image_crc32: 1, image_version: "2.4" }), "invalid_params");
  assert.equal(code("expert_command", { line: "pwr" }), undefined);
  for (const line of ["tbar X1234567890", "updata", "eepe 0", "eepw 0 1 2 3", "flaw 1 2 3", "mm 1 2 3", "pwr;shut", "help eepe", "login x", "a".repeat(49)]) assert.equal(code("expert_command", { line }), "invalid_params", line);
  assert.equal(expertLine("  bat   3 "), "bat 3");
});

// ---- the service -----------------------------------------------------------------------------------------------------------------------------

const battery = (node = "solar-1", device = "pack", stale = false): SolarBattery => ({ kind: "battery", node_id: node, device, timestamp_ms: 1, modules: 1, voltage_v: 51, current_a: 0, stack: [{ n: 1, present: true }] }) as SolarBattery & { stale?: boolean };

function bench(options: { enabled?: boolean; publishFails?: boolean; file?: string; pieceWaitMs?: number } = {}) {
  let clock = 1_000_000;
  const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const solar = new SolarStore({ now: () => clock });
  solar.ingest(battery());
  let counter = 0;
  const service = new BatteryWriteService({
    enabled: options.enabled ?? true, solar, audit: log, now: () => clock, random: () => `c${String(++counter).padStart(15, "0")}`, pieceWaitMs: options.pieceWaitMs ?? 5000, file: options.file,
    publish: (topic, payload) => { if (options.publishFails) throw new Error("down"); sent.push({ topic, payload: JSON.parse(payload) as Record<string, unknown> }); },
  });
  const identity = { model: "US3000C", serial: "PPTBH02200409223", soft_version: "V3.0", board: "" };
  const result = (over: Record<string, unknown>): BatteryResult => parseBatteryResult({ kind: "solar_battery_result", node_id: "solar-1", timestamp_ms: 9, port: 2, accepted: true, refusal: "none", ...over });
  const last = () => sent[sent.length - 1].payload;
  /** The node accepts the arm that was just published. */
  const armed = (token = "0123456789abcdef0123456789abcdef", over: Record<string, unknown> = {}) => service.handleResult(result({
    command_id: last().command_id, action: "arm", op: last().op, stage: "armed", token, canonical: "output_set cfet off", summary: "switch cfet off", risk: "medium", atomic: false, battery: identity,
    snapshot_before: "## output\ncfet   : ON\n", ...over }), "solar-1");
  return { service, solar, sent, audit, last, armed, result, tick: (ms: number) => { clock += ms; solar.ingest(battery()); }, quiet: (ms: number) => { clock += ms; }, identity };
}
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (error) { return error instanceof BatteryOpsError ? error.code : `other:${String(error)}`; } return undefined; };
const outputOff = { node: "solar-1", port: 2, op: "output_set", params: { output: "cfet", state: "off" }, serial: "PPTBH02200409223" };

test("writing off, nothing is sent and every refusal is audited", () => {
  const b = bench({ enabled: false });
  assert.equal(code(() => b.service.arm("admin", outputOff)), "battery_write_disabled");
  assert.equal(code(() => b.service.execute("admin", "0123456789abcdef", "PPTBH02200409223")), "battery_write_disabled");
  assert.equal(code(() => b.service.storeImage("admin", Buffer.alloc(100))), "battery_write_disabled");
  assert.equal(b.sent.length, 0);
  assert.equal(b.audit.filter(event => event.outcome === "denied").length, 3);
  assert.equal(b.service.catalog().enabled, false);
});

test("an order needs a node with a battery that reports, a known operation, good values and a serial number", () => {
  const b = bench();
  for (const bad of [{ ...outputOff, node: "Bad Node" }, { ...outputOff, port: 0 }, { ...outputOff, port: 11 }, { ...outputOff, port: "2" }, { ...outputOff, op: "format" }, { ...outputOff, serial: "x" }, { ...outputOff, serial: 5 }]) {
    assert.equal(code(() => b.service.arm("admin", bad as never)), "invalid_request", JSON.stringify(bad));
  }
  assert.equal(code(() => b.service.arm("admin", { ...outputOff, params: { output: "mostest", state: "on" } })), "invalid_params");
  assert.equal(code(() => b.service.arm("admin", { ...outputOff, node: "other-node" })), "unknown_node");
  b.quiet(200_000);                                                   // the node has been silent for over two minutes
  assert.equal(code(() => b.service.arm("admin", outputOff)), "unknown_node");
  assert.equal(b.sent.length, 0);
});

test("arm, then execute with the token, then the node's final answer: the whole way, and the token is never shown", () => {
  const b = bench();
  const token = "feedfacefeedfacefeedfacefeedface";
  const record = b.service.arm("ana", outputOff);
  assert.equal(record.stage, "arming");
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].topic, "armor/solar/solar-1/maintenance/command");
  assert.doesNotThrow(() => parseBatteryCommand(b.sent[0].payload));
  assert.deepEqual([b.last().action, b.last().op, b.last().port, b.last().serial, "token" in b.last()], ["arm", "output_set", 2, "PPTBH02200409223", false]);
  // not armed yet: nothing to execute
  assert.equal(code(() => b.service.execute("ana", record.id, outputOff.serial)), "not_armed");
  b.armed(token);
  const armed = b.service.get(record.id)!;
  assert.deepEqual([armed.stage, armed.risk, armed.atomic, armed.canonical, armed.battery?.model], ["armed", "medium", false, "output_set cfet off", "US3000C"]);
  assert.ok(armed.armed_until);
  // the wrong serial, and another person, are refused
  assert.equal(code(() => b.service.execute("ana", record.id, "PPTBH02200409224")), "serial_mismatch");
  assert.equal(code(() => b.service.execute("bob", record.id, outputOff.serial)), "not_armed");
  const started = b.service.execute("ana", record.id, outputOff.serial);
  assert.equal(started.stage, "starting");
  assert.equal(b.sent.length, 2);
  assert.doesNotThrow(() => parseBatteryCommand(b.last()));
  assert.deepEqual([b.last().action, b.last().token, b.last().serial], ["execute", token, outputOff.serial]);
  // one arm, one execute
  assert.equal(code(() => b.service.execute("ana", record.id, outputOff.serial)), "not_armed");
  // the node starts, reports and ends
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", op: "output_set", stage: "started" }), "solar-1");
  assert.equal(b.service.get(record.id)!.stage, "running");
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", stage: "progress", outcome: "running", steps_done: 3, steps_total: 9 }), "solar-1");
  assert.deepEqual([b.service.get(record.id)!.steps_done, b.service.get(record.id)!.steps_total], [3, 9]);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", stage: "final", outcome: "ok", steps_done: 9, steps_total: 9, writes_done: 1,
    before: "## output\ncfet   : ON\n## time\nTime : 25-03-09 19:01:42\n", after: "## output\ncfet   : OFF\n", transcript: "> ctrl cfet off\n" }), "solar-1");
  const done = b.service.get(record.id)!;
  assert.deepEqual([done.stage, done.outcome], ["done", "ok"]);
  assert.deepEqual(done.diff, [{ label: "output", before: "cfet   : ON", after: "cfet   : OFF" }]);
  assert.deepEqual(done.restore, { op: "output_set", params: { output: "cfet", state: "on" } });   // what an output was can be put back
  // the token is nowhere: not in a record, not in the list, not in the audit trail
  const everything = JSON.stringify([b.service.list(), b.service.get(record.id), b.audit]);
  assert.ok(!everything.includes(token));
  assert.ok(b.audit.some(event => event.action === "battery.result" && event.outcome === "allowed"));
  assert.ok(b.audit.every(event => !JSON.stringify(event).includes(token)));
});

test("an arm that was not used expires, and a node that goes quiet is lost", () => {
  const b = bench();
  const first = b.service.arm("ana", outputOff);
  b.armed();
  b.tick(116_000);
  assert.equal(code(() => b.service.execute("ana", first.id, outputOff.serial)), "expired");
  assert.equal(b.service.get(first.id)!.stage, "expired");
  const second = b.service.arm("ana", outputOff);
  b.armed();
  b.service.execute("ana", second.id, outputOff.serial);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", stage: "started" }), "solar-1");
  b.tick(121_000);
  b.service.sweep();
  assert.deepEqual([b.service.get(second.id)!.stage, b.service.get(second.id)!.code], ["lost", "node_went_quiet"]);
  const third = b.service.arm("ana", outputOff);
  b.tick(61_000);
  b.service.sweep();
  assert.equal(b.service.get(third.id)!.stage, "lost");                  // the node never answered the arm
});

test("one operation at a time per battery, and a newer arm withdraws an older one that was not used", () => {
  const b = bench();
  const first = b.service.arm("ana", outputOff);
  assert.equal(code(() => b.service.arm("ana", outputOff)), "busy");
  b.armed();
  const second = b.service.arm("ana", outputOff);
  assert.equal(b.service.get(first.id)!.stage, "withdrawn");
  assert.notEqual(second.id, first.id);
  b.armed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  b.service.execute("ana", second.id, outputOff.serial);
  assert.equal(code(() => b.service.arm("ana", outputOff)), "busy");                                    // running
  assert.equal(code(() => b.service.arm("ana", { ...outputOff, port: 3 })), undefined);                  // another port is free
});

test("the node refuses: the operation ends rejected with its refusal, and an answer nobody asked for is dropped", () => {
  const b = bench();
  const record = b.service.arm("ana", outputOff);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "arm", stage: "rejected", accepted: false, refusal: "serial_mismatch" }), "solar-1");
  assert.deepEqual([b.service.get(record.id)!.stage, b.service.get(record.id)!.refusal], ["rejected", "serial_mismatch"]);
  // an answer to an order this server did not send, or from another node, changes nothing
  const before = JSON.stringify(b.service.list());
  b.service.handleResult(b.result({ command_id: "ffffffffffffffff", action: "arm", stage: "rejected", accepted: false, refusal: "busy" }), "solar-1");
  const next = b.service.arm("ana", outputOff);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "arm", op: "output_set", stage: "armed", token: "0123456789abcdef0123456789abcdef", canonical: "x", summary: "x", risk: "low", battery: b.identity }), "other-node");
  assert.equal(b.service.get(next.id)!.stage, "arming");
  assert.ok(JSON.stringify(b.service.list()) !== before);
  assert.ok(b.audit.some(event => event.action === "battery.result" && event.outcome === "denied" && String(event.detail).includes("not an answer")));
});

test("the broker is not connected: nothing is armed, and the operation ends", () => {
  const b = bench({ publishFails: true });
  assert.equal(code(() => b.service.arm("ana", outputOff)), "mqtt_unavailable");
  assert.equal(b.service.list()[0].stage, "rejected");
});

test("cancel withdraws an armed operation, and asks the node to stop a running one", () => {
  const b = bench();
  const record = b.service.arm("ana", outputOff);
  b.armed();
  assert.equal(b.service.cancel("ana", record.id).stage, "withdrawn");
  assert.equal(code(() => b.service.execute("ana", record.id, outputOff.serial)), "not_armed");
  const second = b.service.arm("ana", outputOff);
  b.armed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  b.service.execute("ana", second.id, outputOff.serial);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", stage: "started" }), "solar-1");
  b.service.cancel("ana", second.id);
  assert.equal(b.last().action, "cancel");
  assert.doesNotThrow(() => parseBatteryCommand(b.last()));
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "cancel", stage: "rejected", accepted: false, refusal: "not_cancellable" }), "solar-1");
  assert.equal(b.service.get(second.id)!.stage, "running");                                             // the node said no: it goes on
  assert.equal(code(() => b.service.cancel("ana", "00000000000000ff")), "unknown_operation");
});

test("restore arms the operation that puts an output back", () => {
  const b = bench();
  const record = b.service.arm("ana", outputOff);
  b.armed();
  b.service.execute("ana", record.id, outputOff.serial);
  b.service.handleResult(b.result({ command_id: b.last().command_id, action: "execute", stage: "final", outcome: "ok", before: "## output\ncfet   : ON\n", after: "## output\ncfet   : OFF\n" }), "solar-1");
  const undo = b.service.restore("ana", record.id, outputOff.serial);
  assert.equal(undo.op, "output_set");
  assert.deepEqual(undo.params, { output: "cfet", state: "on" });
  assert.equal(code(() => b.service.restore("ana", undo.id, outputOff.serial)), "not_restorable");     // nothing was done yet
  const clock = bench();
  const c = clock.service.arm("ana", { ...outputOff, op: "set_clock", params: {} });
  clock.armed("cccccccccccccccccccccccccccccccc", { canonical: "set_clock" });
  clock.service.execute("ana", c.id, outputOff.serial);
  clock.service.handleResult(clock.result({ command_id: clock.last().command_id, action: "execute", stage: "final", outcome: "ok", before: "## time\nTime : 25-03-09\n", after: "## time\nTime : 26-10-19\n" }), "solar-1");
  assert.equal(code(() => clock.service.restore("ana", c.id, outputOff.serial)), "not_restorable");
});

test("the operations are kept in a file without any token, and one that was on its way when the server stopped is called lost", () => {
  const file = path.join(tempDir(), "battery_ops.json");
  const b = bench({ file });
  const record = b.service.arm("ana", outputOff);
  b.armed("dddddddddddddddddddddddddddddddd");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("dddddddddddddddddddddddddddddddd"));
  assert.ok(text.includes(record.id));
  const again = bench({ file });
  assert.equal(again.service.get(record.id)?.stage, "lost");
  assert.equal(code(() => again.service.execute("ana", record.id, outputOff.serial)), "not_armed");
});

// ---- a firmware image ----------------------------------------------------------------------------------------------------------------------------

function image(board = "US2000C", major = 2, minor = 4, size = 100_000): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  bytes[0x400] = minor; bytes[0x401] = major;
  bytes.fill(0, 0x418, 0x418 + 11);
  bytes.write(board, 0x418, "ascii");
  return bytes;
}

test("an image is read for what it says it is, and nothing else is accepted", () => {
  const good = image();
  const info = describeImage(good);
  assert.deepEqual([info.board, info.version, info.size, info.major, info.minor], ["US2000C", "2.4", 100_000, 2, 4]);
  assert.equal(info.crc32, crc32(good));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  for (const bad of [Buffer.alloc(100), Buffer.alloc(600_000), image("")]) assert.throws(() => describeImage(bad), BatteryOpsError);
  const garbled = image(); garbled[0x418] = 7;
  assert.throws(() => describeImage(garbled), BatteryOpsError);
});

test("a firmware update stages the image piece by piece, then arms; a piece that is refused ends it", async () => {
  const b = bench();
  const kept = b.service.storeImage("ana", image());
  assert.equal(kept.board, "US2000C");
  const record = b.service.arm("ana", { ...outputOff, op: "firmware_update", params: { image_id: kept.image_id } });
  assert.equal(record.stage, "arming");
  assert.deepEqual(record.params, { image_size: 100_000, image_crc32: kept.crc32, image_version: "2.4" });
  assert.equal(record.image?.sha256, kept.sha256);
  const total = Math.ceil(100_000 / 256);
  let received = 0;
  for (let step = 0; step < total; step += 1) {
    await new Promise(resolve => setImmediate(resolve));
    const message = b.last();
    assert.equal(message.action, "stage");
    assert.doesNotThrow(() => parseBatteryCommand(message));
    const piece = message.stage as { index: number; data: string; total: number };
    assert.equal(piece.index, step);
    received += Buffer.from(piece.data, "base64").length;
    b.service.handleResult(b.result({ command_id: message.command_id, action: "stage", stage: "staged", received }), "solar-1");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, 100_000);
  assert.equal(b.last().action, "arm");
  assert.deepEqual(b.last().params, { image_size: 100_000, image_crc32: kept.crc32, image_version: "2.4" });
  assert.equal(b.service.get(record.id)!.staging, undefined);
  // an image that is not kept (or too old) cannot be armed
  assert.equal(code(() => b.service.arm("ana", { ...outputOff, op: "firmware_update", params: { image_id: kept.image_id } })), "busy");   // the operation is still waiting for its arm
  const c = bench();
  assert.equal(code(() => c.service.arm("ana", { ...outputOff, op: "firmware_update", params: { image_id: "nothing" } })), "image_missing");
  assert.equal(code(() => c.service.arm("ana", { ...outputOff, op: "firmware_update", params: {} })), "image_missing");
  // a piece the node refuses ends the operation
  const d = bench();
  const kept2 = d.service.storeImage("ana", image());
  const r2 = d.service.arm("ana", { ...outputOff, op: "firmware_update", params: { image_id: kept2.image_id } });
  await new Promise(resolve => setImmediate(resolve));
  d.service.handleResult(d.result({ command_id: d.last().command_id, action: "stage", stage: "rejected", accepted: false, refusal: "no_memory" }), "solar-1");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([d.service.get(r2.id)!.stage, d.service.get(r2.id)!.refusal], ["rejected", "no_memory"]);
  // a piece nobody acknowledges ends it too
  const e = bench({ pieceWaitMs: 50 });
  const kept3 = e.service.storeImage("ana", image());
  const r3 = e.service.arm("ana", { ...outputOff, op: "firmware_update", params: { image_id: kept3.image_id } });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual([e.service.get(r3.id)!.stage, e.service.get(r3.id)!.refusal], ["rejected", "no_answer"]);
});

test("differences shows only what the writes changed, and an output's earlier state can be read", () => {
  assert.deepEqual(differences("## time\nTime : 1\n## stat\nx : 1\n", "## time\nTime : 2\n"), [{ label: "time", before: "Time : 1", after: "Time : 2" }]);
  assert.deepEqual(differences("## a\n1\n", "## a\n1\n"), []);
  assert.deepEqual(differences("", "## a\n1\n"), [{ label: "a", before: "", after: "1" }]);
  assert.equal(outputBefore("## output\nctrl cfet\n@\ncfet   : ON  \n", "cfet"), "on");
  assert.equal(outputBefore("## output\ndfet : OFF\n", "dfet"), "off");
  assert.equal(outputBefore("## output\nnothing\n", "cfet"), undefined);
  assert.equal(outputBefore("", "cfet"), undefined);
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------------------------

test("by default no route writes anything, and every route that does asks for an administrator and a fresh proof", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = { cookie }) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await send("POST", "/api/v1/solar/battery-ops", outputOff, {})).status, 401);
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    assert.equal((await send("POST", "/api/v1/solar/battery-ops", outputOff, operator)).status, 401);          // the operator token is not an administrator
    assert.equal((await send("GET", "/api/v1/solar/battery-ops", undefined, operator)).status, 401);
    const catalog = await send("GET", "/api/v1/solar/battery-ops/catalog", undefined, operator);                 // the table may be looked at
    assert.equal(catalog.status, 200);
    const table = (await catalog.json()) as { enabled: boolean; catalog: { ops: unknown[] } };
    assert.equal(table.enabled, false);
    assert.equal(table.catalog.ops.length, 20);
    const noProof = await send("POST", "/api/v1/solar/battery-ops", outputOff);
    assert.deepEqual([noProof.status, ((await noProof.json()) as { code: string }).code], [403, "elevation_required"]);   // even from inside the house
    // after the proof, it is still off
    assert.equal((await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
    const off = await send("POST", "/api/v1/solar/battery-ops", outputOff);
    assert.deepEqual([off.status, ((await off.json()) as { code: string }).code], [403, "battery_write_disabled"]);
    assert.equal((await send("POST", "/api/v1/solar/battery-ops/aaaaaaaaaaaa/execute", { serial: "x" })).status, 403);
    assert.equal(((await (await send("GET", "/api/v1/solar/battery-ops")).json()) as { enabled: boolean }).enabled, false);
    assert.equal((await send("GET", "/api/v1/solar/battery-ops/aaaaaaaaaaaa")).status, 404);
    assert.equal((await send("GET", "/api/v1/solar/battery-ops/short")).status, 404);
  } finally { await running.stop(); }
});

test("turned on, the whole way through the routes, with the node's answers made here, and the history says who did what", async () => {
  const running = await startServer({ ARMOR_BATTERY_WRITE: "1" });
  try {
    assert.ok(running.config.warnings.some(warning => warning.includes("ARMOR_BATTERY_WRITE")));
    const published: Array<Record<string, unknown>> = [];
    running.app.context.batteryLink.publish = (_topic, payload) => { published.push(JSON.parse(payload) as Record<string, unknown>); };
    running.app.context.solar.ingest(battery());
    const cookie = await studioCookie(running.base);
    const send = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
    assert.equal((await send("POST", "/api/v1/solar/battery-ops", { ...outputOff, params: { output: "nope", state: "on" } })).status, 400);
    assert.equal((await send("POST", "/api/v1/solar/battery-ops", { ...outputOff, node: "elsewhere" })).status, 404);
    const armed = await send("POST", "/api/v1/solar/battery-ops", outputOff);
    assert.equal(armed.status, 202);
    const record = (await armed.json()) as { id: string; stage: string };
    assert.equal(record.stage, "arming");
    const answer = (over: Record<string, unknown>) => running.app.context.batteryWrite.handleResult(parseBatteryResult({ kind: "solar_battery_result", node_id: "solar-1", timestamp_ms: 9, port: 2, accepted: true, refusal: "none", ...over }), "solar-1");
    answer({ command_id: published[0].command_id, action: "arm", op: "output_set", stage: "armed", token: "0123456789abcdef0123456789abcdef", canonical: "output_set cfet off", summary: "switch cfet off", risk: "medium", atomic: false,
      battery: { model: "US3000C", serial: "PPTBH02200409223", soft_version: "V3.0", board: "" } });
    const shown = await send("GET", `/api/v1/solar/battery-ops/${record.id}`);
    const text = await shown.text();
    assert.ok(!text.includes("0123456789abcdef0123456789abcdef"), "a token is never in an answer");
    assert.equal((JSON.parse(text) as { stage: string }).stage, "armed");
    assert.equal((await send("POST", `/api/v1/solar/battery-ops/${record.id}/execute`, { serial: "PPTBH02200409224" })).status, 400);
    const executed = await send("POST", `/api/v1/solar/battery-ops/${record.id}/execute`, { serial: outputOff.serial });
    assert.equal(executed.status, 202);
    assert.equal(published[1].action, "execute");
    assert.equal(published[1].token, "0123456789abcdef0123456789abcdef");
    answer({ command_id: published[1].command_id, action: "execute", stage: "final", outcome: "ok", before: "## output\ncfet   : ON\n", after: "## output\ncfet   : OFF\n" });
    const list = (await (await send("GET", "/api/v1/solar/battery-ops")).json()) as { enabled: boolean; operations: Array<{ id: string; stage: string; outcome?: string; restore?: unknown }> };
    assert.equal(list.enabled, true);
    assert.deepEqual([list.operations[0].id, list.operations[0].stage, list.operations[0].outcome], [record.id, "done", "ok"]);
    assert.ok(list.operations[0].restore);
    // the history has the category, with the actor and the outcome, and nothing else
    const history = (await (await send("GET", "/api/v1/history?category=batteries&all=1")).json()) as { events: Array<{ category: string; action: string; subject: string; by: string; outcome: string }> } | Array<{ category: string; action: string; subject: string; by: string; outcome: string }>;
    const events = Array.isArray(history) ? history : history.events;
    assert.ok(events.some(event => event.category === "batteries" && event.action === "battery_operation" && event.by === SECRETS.ARMOR_STUDIO_USERNAME && event.outcome === "allowed" && event.subject === "solar-1/2"));
    assert.ok(events.some(event => event.action === "battery_requested"));
    // an image: only a binary body, and only one of the family
    const post = (body: Buffer, type = "application/octet-stream") => fetch(`${running.base}/api/v1/solar/battery-ops/images`, { method: "POST", headers: { "Content-Type": type, cookie }, body: new Uint8Array(body) });
    assert.equal((await post(Buffer.from("{}"), "application/json")).status, 415);
    assert.equal((await post(Buffer.alloc(100))).status, 400);
    const stored = await post(image());
    assert.equal(stored.status, 201);
    assert.equal(((await stored.json()) as { board: string }).board, "US2000C");
  } finally { await running.stop(); }
});

test("the table lists the operations and what each one needs", { skip }, () => {
  const ids: string[] = BATTERY_CATALOG.ops.map(item => item.id);
  for (const wanted of ["set_clock", "clear_stats", "clear_log", "clear_data", "restart", "shutdown", "soc_capacity", "mosfail_test", "soc_reset", "pcb_setup", "limits_set", "limits_default", "protections_set", "protections_default", "output_set", "fault_clear", "write_barcode", "eeprom_erase", "firmware_update", "expert_command"]) assert.ok(ids.includes(wanted), wanted);
  for (const item of BATTERY_CATALOG.ops) if (item.risk === "irreversible") assert.ok(item.atomic && item.needs_idle, item.id);
});
