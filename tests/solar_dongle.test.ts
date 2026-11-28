// The reader of an inverter's Wi-Fi dongle against a simulated dongle on this machine: off by default (no port), the strict file, who may connect, the limits, that only reading
// questions can be built, and the readings of a PI30 and a PI18 inverter reaching the solar store. No real dongle or inverter has been tried.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { parseSolarInverter } from "../src/solar.js";
import { DONGLE_FILE, isHouseAddress, parseDongleConfig, SolarDongle } from "../src/solar_dongle.js";
import { crcBytes, dongleFrame, parseFws, parseGs, parseQpigs, parseQpiri, parseQpiws, QUESTION_NAMES, questionBytes, questionFrame, readHeader, replyText, type Question } from "../src/solar_dongle_protocol.js";

// ---- the replies of an invented inverter ----------------------------------------------------------------------------------------------------

const QPIGS = "230.1 50.0 229.9 50.0 4200 4010 038 405 53.20 010 082 0041 05.2 320.1 00.00 00000 00010110 00 00 01650 010";
const PI30: Record<string, string> = {
  QPI: "PI30", QID: "96100000000001", QVFW: "VERFW:00041.54", QMOD: "L", QPIGS, QPIGS2: "03.1 327.3 01026", QPIWS: "0".repeat(16) + "1" + "0".repeat(19),
  QPIRI: "230.0 47.8 230.0 50.0 47.8 11000 11000 48.0 46.0 42.0 56.4 54.0 2 030 060 0 1 2",
};
const GS = "2301,500,2299,500,4200,4010,038,532,532,532,000,010,082,041,038,039,1650,1026,3201,3273,0,2,1,1,1,1,1,0";
const PI18: Record<string, string> = { PI: "18", ID: "1496100000000001000000", VFW: "00041,00000,00000", MOD: "05", GS, FWS: "00,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0" };

const pi30Reply = (text: string): Buffer => { const head = Buffer.from(`(${text}`, "ascii"); return Buffer.concat([head, crcBytes(head), Buffer.from("\r")]); };
const pi18Reply = (text: string): Buffer => { const head = Buffer.from(`^D${String(text.length + 3).padStart(3, "0")}${text}`, "ascii"); return Buffer.concat([head, crcBytes(head), Buffer.from("\r")]); };

type Fake = { socket: net.Socket; asked: string[]; functions: number[]; closed: Promise<void> };

/** A dongle of the maker as far as the transport goes: answers the heartbeat and passes the questions to an invented inverter. */
function fakeDongle(port: number, protocol: "pi30" | "pi18" | "pi17"): Fake {
  const socket = net.connect(port, "127.0.0.1");
  const fake: Fake = { socket, asked: [], functions: [], closed: new Promise(resolve => socket.on("close", () => resolve())) };
  let buffer = Buffer.alloc(0);
  socket.on("error", () => undefined);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    while (buffer.length >= 8) {
      const header = readHeader(buffer, 2048)!;
      const total = 8 + header.payloadLength;
      if (buffer.length < total) return;
      const payload = buffer.subarray(8, total);
      buffer = Buffer.from(buffer.subarray(total));
      fake.functions.push(header.functionCode);
      if (header.functionCode === 1) { socket.write(dongleFrame(header.transaction, 2452, 1, 1, Buffer.from("SIMDONGLE0001"))); continue; }
      const text = payload.subarray(0, payload.length - 3).toString("ascii");
      const question = text.startsWith("^P") ? text.slice(5) : text;
      fake.asked.push(question);
      let reply: Buffer | undefined;
      if (protocol === "pi30") reply = text.startsWith("^") ? undefined : pi30Reply(PI30[question] ?? "NAK");
      else if (protocol === "pi17") reply = question === "QPI" ? pi30Reply("PI17") : undefined;
      else reply = text.startsWith("^P") && PI18[question] !== undefined ? pi18Reply(PI18[question]) : undefined;
      if (reply) socket.write(dongleFrame(header.transaction, header.deviceCode, header.address, 4, reply));
    }
  });
  return fake;
}

const freePort = (): Promise<number> => new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

const refused = (port: number): Promise<boolean> => new Promise(resolve => { const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(false); }); socket.on("error", () => resolve(true)); });

type Rig = { dongle: SolarDongle; port: number; messages: Array<Record<string, unknown>>; lines: string[]; on: { value: boolean } };

async function rig(extra: Record<string, unknown> = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-dongle-"));
  const port = await freePort();
  const file = path.join(dir, DONGLE_FILE);
  fs.writeFileSync(file, JSON.stringify({ listen_address: "127.0.0.1", port, dongles: [{ address: "127.0.0.1" }], ...extra }));
  const messages: Rig["messages"] = [], lines: string[] = [], on = { value: true };
  const dongle = new SolarDongle({ file, enabled: () => on.value, publish: message => { messages.push(parseSolarInverter(message) as unknown as Record<string, unknown>); }, log: line => lines.push(line), warn: line => lines.push(line),
    timings: { pollMs: 20, requestTimeoutMs: 250, heartbeatMs: 5000, readyMs: 2000 } });
  return { dongle, port, messages, lines, on };
}

// ---- what can be built -------------------------------------------------------------------------------------------------------------------------

test("only reading questions can be built: no setting command and no redirect datagram", () => {
  for (const name of QUESTION_NAMES) {
    const text = questionBytes(name).toString("ascii");
    assert.ok(/^(Q[A-Z0-9]+|\^P\d{3}[A-Z]+)/.test(text), name);
    assert.ok(!text.startsWith("^S"), name);
  }
  for (const word of ["POP02", "PCP00", "PBT01", "PF", "^S005POP", "set>server=192.168.1.2:8899;", "toString", "__proto__"]) {
    assert.throws(() => questionBytes(word as Question), /not a reading question/, word);
    assert.throws(() => questionFrame(1, word as Question, 2452, 1), /not a reading question/, word);
  }
  const copy = questionBytes("QPI");
  copy.fill(0);
  assert.equal(questionBytes("QPI").toString("ascii").slice(0, 3), "QPI", "a caller cannot change the table");
  const source = ["solar_dongle.ts", "solar_dongle_protocol.ts"].map(name => fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", name), "utf8")).join("\n");
  assert.ok(!source.includes("set>server") && !/\bdgram\b/.test(source), "this server sends nothing to a dongle that did not call it");
});

test("a reply with a wrong CRC, a wrong length or no end is not read", () => {
  const good = pi30Reply("PI30");
  assert.equal(replyText(good), "PI30");
  const bad = Buffer.from(good); bad[1] ^= 1;
  assert.equal(replyText(bad), undefined);
  assert.equal(replyText(good.subarray(0, good.length - 1)), undefined);
  assert.equal(replyText(pi30Reply("NAK")), "NAK");
  assert.equal(replyText(pi18Reply("18")), "18");
  const short = Buffer.from("^D00918", "ascii");
  assert.equal(replyText(Buffer.concat([short, crcBytes(short), Buffer.from("\r")])), undefined);
});

test("the readings of both protocols are decoded, and absurd or broken fields are held or refused", () => {
  const status = parseQpigs(QPIGS)!;
  assert.deepEqual([status.out_w, status.battery_v, status.battery_a, status.pv_w, status.load_on, status.pv_charging, status.ac_charging], [4010, 53.2, 10, 1650, true, true, false]);
  assert.deepEqual(parseQpigs(QPIGS.replace("038", "255"))!.clamped, ["load_percent"]);
  assert.equal(parseQpigs("230.1 50.0"), undefined);
  assert.equal(parseGs(GS)!.pv_w, 2676);
  assert.equal(parseGs(GS.replace(",041,", ",-05,"))!.heatsink_c, -5);
  assert.equal(parseGs("1,2,3"), undefined);
  assert.deepEqual(parseQpiws("1".repeat(2) + "0".repeat(34)), ["pv_loss", "inverter_fault"]);
  assert.equal(parseQpiws("hello"), undefined);
  assert.deepEqual(parseFws("07,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"), ["inverter_fault", "fault_code_7", "line_fail"]);
  assert.deepEqual([parseQpiri(PI30.QPIRI)!.out_rating_w, parseQpiri(PI30.QPIRI)!.charger_priority], [11000, "solar_and_utility"]);
});

// ---- the file --------------------------------------------------------------------------------------------------------------------------------

test("the file is read strictly and only house addresses are taken", () => {
  for (const address of ["192.168.1.9", "10.0.0.1", "172.16.0.1", "172.31.255.1", "127.0.0.1"]) assert.ok(isHouseAddress(address), address);
  for (const address of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "169.254.1.1", "::1", "dongle.local", "", 5]) assert.ok(!isHouseAddress(address), String(address));
  const base = { listen_address: "192.168.1.2", dongles: [{ address: "192.168.1.50" }] };
  const config = parseDongleConfig(base);
  assert.deepEqual([config.port, config.node_id, config.dongles[0].device, config.protocol, config.max_frame_bytes], [8899, "wifi-dongle", "inverter", "auto", 512]);
  for (const bad of [{ ...base, listen_address: "0.0.0.0" }, { listen_address: base.listen_address }, { ...base, dongles: [] }, { ...base, dongles: [{ address: "8.8.8.8" }] }, { ...base, allow_all: true },
    { ...base, dongles: [{ address: "192.168.1.50" }, { address: "192.168.1.50", device: "b" }] }, { ...base, port: 80 }, { ...base, max_frame_bytes: 100_000 }, { ...base, protocol: "modbus" },
    { ...base, node_id: "Wifi Dongle" }, [], null]) assert.throws(() => parseDongleConfig(bad), JSON.stringify(bad));
});

// ---- the option and the port ---------------------------------------------------------------------------------------------------------------------

test("off by default: the option is off, counts as lowering protection when turned on, and no port is open", async () => {
  assert.equal(SECURITY_DEFAULTS["solar.wifi_dongle"], false);
  assert.equal(lowers("solar.wifi_dongle", false, true), true);
  assert.equal(lowers("solar.wifi_dongle", true, false), false);
  const { dongle, port, on } = await rig();
  on.value = false;
  await dongle.sync();
  assert.equal(dongle.port, undefined);
  assert.equal(await refused(port), true);
  on.value = true;
  await dongle.sync();
  assert.equal(dongle.port, port);
  on.value = false;
  await dongle.sync();
  assert.equal(await refused(port), true);
  await dongle.close();
});

test("on without a good file nothing is opened, and the reason is said once", async () => {
  const { dongle, lines } = await rig({ listen_address: "0.0.0.0" });
  await dongle.sync();
  await dongle.sync();
  assert.equal(dongle.port, undefined);
  assert.equal(lines.filter(line => line.includes("NOT_LISTENING")).length, 1);
  await dongle.close();
});

// ---- a simulated dongle ----------------------------------------------------------------------------------------------------------------------------

test("a PI30 inverter behind a simulated dongle is read with questions only, and turning the option off ends it", async () => {
  const { dongle, port, messages, lines, on } = await rig();
  await dongle.sync();
  const fake = fakeDongle(port, "pi30");
  await until(() => messages.length >= 2);
  const reading = messages[0] as Record<string, any>;
  assert.deepEqual([reading.node_id, reading.device, reading.mode, reading.out_w, reading.pv_w, reading.pv2_w, reading.serial, reading.firmware], ["wifi-dongle", "inverter", "line", 4010, 2676, 1026, "96100000000001", "00041.54"]);
  assert.deepEqual(reading.warnings, ["overload"]);
  assert.equal(reading.ratings.out_rating_w, 11000);
  assert.ok(fake.asked.every(question => question.startsWith("Q")));
  assert.ok(fake.functions.every(code => code === 1 || code === 4));
  assert.ok(!lines.join("\n").includes("SIMDONGLE") && !lines.join("\n").includes(PI30.QID), "neither the dongle's number nor the inverter's is logged");
  on.value = false;
  await dongle.sync();
  await fake.closed;
  await dongle.close();
});

test("a PI18 inverter is found and read", async () => {
  const { dongle, port, messages } = await rig({ protocol: "auto" });
  await dongle.sync();
  const fake = fakeDongle(port, "pi18");
  await until(() => messages.length >= 1, 8000);
  const reading = messages[0] as Record<string, any>;
  assert.deepEqual([reading.mode, reading.out_w, reading.pv_w, reading.battery_v, reading.serial, reading.firmware], ["line", 4010, 2676, 53.2, "96100000000001", "00041"]);
  fake.socket.destroy();
  await dongle.close();
});

test("a protocol that is not read is said and nothing else is asked", async () => {
  const { dongle, port, messages, lines } = await rig();
  await dongle.sync();
  const fake = fakeDongle(port, "pi17");
  await until(() => lines.some(line => line.includes("UNSUPPORTED_PROTOCOL protocol") || line.includes("protocol=PI17")));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(fake.asked, ["QPI"]);
  assert.equal(messages.length, 0);
  fake.socket.destroy();
  await dongle.close();
});

test("an address that is not listed is closed before anything is sent to it", async () => {
  const { dongle, port, lines } = await rig({ dongles: [{ address: "192.168.1.50" }] });
  await dongle.sync();
  const fake = fakeDongle(port, "pi30");
  await fake.closed;
  assert.deepEqual(fake.functions, []);
  assert.ok(lines.some(line => line.includes("REFUSED")));
  await dongle.close();
});

test("too large a frame, too many frames, too many bytes and an unknown kind of frame end the connection", async () => {
  const cases: Array<[string, (socket: net.Socket) => void]> = [
    ["size", socket => { const frame = Buffer.alloc(8); frame.writeUInt16BE(60_000, 4); socket.write(frame); }],
    ["frames", socket => socket.write(Buffer.concat(Array.from({ length: 30 }, () => dongleFrame(9, 2452, 1, 4, Buffer.alloc(1)))))],
    ["bytes", socket => socket.write(Buffer.alloc(2000))],
    ["function", socket => socket.write(dongleFrame(9, 2452, 1, 99, Buffer.alloc(1)))],
  ];
  for (const [name, send] of cases) {
    const { dongle, port, lines } = await rig({ max_bytes_per_s: 1024 });
    await dongle.sync();
    const socket = net.connect(port, "127.0.0.1");
    const closed = new Promise<void>(resolve => socket.on("close", () => resolve()));
    socket.on("error", () => undefined);
    socket.resume();
    socket.on("connect", () => send(socket));
    await closed;
    assert.ok(lines.some(line => line.includes("DISCONNECTED")), name);
    await dongle.close();
  }
});

test("connections of one address are limited per minute", async () => {
  const { dongle, port } = await rig({ connections_per_minute: 2 });
  await dongle.sync();
  const results: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fake = fakeDongle(port, "pi30");
    await Promise.race([until(() => fake.asked.length > 0), fake.closed]);
    results.push(fake.asked.length > 0 ? 1 : 0);
    fake.socket.destroy();
    await fake.closed;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(results, [1, 1, 0]);
  await dongle.close();
});
