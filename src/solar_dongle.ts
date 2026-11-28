/**
 * The local reader of an inverter's Wi-Fi dongle (Eybond collectors: SmartESS, SmartClient, WatchPower Wi-Fi). The dongle calls this server over TCP and the server asks the inverter
 * reading questions through it (solar_dongle_protocol.ts); what is read enters the solar store like the message of a gateway node.
 *
 * Off by default (the security option solar.wifi_dongle): while it is off no port is open. On, it listens only if `solar-wifi-dongle.json` of the data directory names one private
 * address of this machine and the addresses of the dongles. The protocol has no authentication and no encryption, so: only listed addresses are taken, frames, bytes and connections
 * are bounded, one connection per dongle. This server never sends the datagram that points a dongle at it: a person does that, knowing the maker's app stops receiving data.
 * NOTHING here has been tried on a real dongle.
 *
 * The transport follows ha-dessmonitor (MIT, see the notice in solar_dongle_protocol.ts).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import net from "node:net";
import {
  FC_FORWARD, FC_HEARTBEAT, HEADER_SIZE, KNOWN_DEVICE_CODES, heartbeatFrame, parseFirmware, parseFws, parseGs, parseMod18, parseQmod, parseQpigs, parseQpigs2, parseQpiri, parseQpiws, parseSerial,
  questionFrame, readHeader, replyText, type DongleHeader, type Question, type Ratings,
} from "./solar_dongle_protocol.js";

export const DONGLE_FILE = "solar-wifi-dongle.json";

export type DongleConfig = {
  listen_address: string; port: number; dongles: Array<{ address: string; device: string }>; node_id: string; protocol: "auto" | "pi30" | "pi18";
  poll_s: number; request_timeout_s: number; max_frame_bytes: number; max_bytes_per_s: number; max_frames_per_s: number; connections_per_minute: number;
};

const NUMBERS = {
  port: [1024, 65535, 8899], poll_s: [5, 300, 10], request_timeout_s: [2, 30, 5], max_frame_bytes: [128, 2048, 512], max_bytes_per_s: [1024, 65536, 8192], max_frames_per_s: [2, 100, 20],
  connections_per_minute: [1, 30, 6],
} as const;
const KEYS = ["listen_address", "dongles", "node_id", "protocol", ...Object.keys(NUMBERS)];
const MAX_DONGLES = 4;

/** A private IPv4 address (10/8, 172.16/12, 192.168/16) or loopback: the only ones listened on and the only dongles taken. */
export function isHouseAddress(value: unknown): value is string {
  if (typeof value !== "string" || net.isIPv4(value) !== true) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The file read strictly: anything not understood refuses the whole file, so a typing mistake never opens more than was meant. Throws with the reason. */
export function parseDongleConfig(raw: unknown): DongleConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the file is not an object");
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => !KEYS.includes(key));
  if (unknown !== undefined) throw new Error(`unknown key ${unknown.slice(0, 40)}`);
  if (!isHouseAddress(body.listen_address)) throw new Error("listen_address must be one private IPv4 address of this machine");
  if (!Array.isArray(body.dongles) || body.dongles.length < 1 || body.dongles.length > MAX_DONGLES) throw new Error(`dongles must list 1 to ${MAX_DONGLES} allowed dongles`);
  const dongles = body.dongles.map((item: unknown, index: number) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const device = entry.device ?? (index === 0 ? "inverter" : `inverter${index + 1}`);
    if (!isHouseAddress(entry.address)) throw new Error("each dongle needs its private IPv4 address");
    if (typeof device !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(device) || Object.keys(entry).some(key => key !== "address" && key !== "device")) throw new Error("a dongle has an address and, optionally, a device name");
    return { address: entry.address, device };
  });
  if (new Set(dongles.map(item => item.address)).size !== dongles.length || new Set(dongles.map(item => item.device)).size !== dongles.length) throw new Error("two dongles share an address or a name");
  const nodeId = body.node_id ?? "wifi-dongle";
  if (typeof nodeId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(nodeId)) throw new Error("node_id is not a valid node name");
  const protocol = body.protocol ?? "auto";
  if (protocol !== "auto" && protocol !== "pi30" && protocol !== "pi18") throw new Error("protocol is auto, pi30 or pi18");
  const numbers = {} as Record<keyof typeof NUMBERS, number>;
  for (const [key, [low, high, fallback]] of Object.entries(NUMBERS) as Array<[keyof typeof NUMBERS, readonly [number, number, number]]>) {
    const value = body[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw new Error(`${key} must be a whole number from ${low} to ${high}`);
    numbers[key] = value;
  }
  return { listen_address: body.listen_address, dongles, node_id: nodeId, protocol: protocol as DongleConfig["protocol"], ...numbers };
}

type Timings = { pollMs?: number; requestTimeoutMs?: number; heartbeatMs?: number; readyMs?: number };

export type SolarDongleOptions = {
  file: string;
  enabled: () => boolean;
  /** Takes a solar_inverter message (it is checked against the contract by the caller's parser). */
  publish: (message: Record<string, unknown>) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
  /** Shorter times for the tests. */
  timings?: Timings;
};

type Route = { protocol: "pi30" | "pi18"; deviceCode: number; address: number };

/** One connected dongle: reads bounded frames, keeps one question in flight and polls the inverter. */
class Session {
  #buffer = Buffer.alloc(0);
  #window = { start: 0, bytes: 0, frames: 0 };
  #pending: { transaction: number; deviceCode: number; address: number; done: (reply: Buffer | undefined) => void } | undefined;
  #transaction = 0;
  #reportedCode = 0;
  #ready = false;
  #closed = false;
  #timers = new Set<NodeJS.Timeout>();
  #wake: (() => void) | undefined;
  lastFrameMs: number;

  constructor(private readonly socket: net.Socket, private readonly device: string, private readonly config: DongleConfig, private readonly options: SolarDongleOptions, private readonly onClose: () => void) {
    this.lastFrameMs = Date.now();
    const heartbeatMs = options.timings?.heartbeatMs ?? 60_000;
    socket.setNoDelay(true);
    socket.on("data", chunk => this.#data(chunk));
    socket.on("error", () => this.close("connection error"));
    socket.on("close", () => this.close("the dongle closed the connection"));
    const beat = (): void => { this.#send(heartbeatFrame(this.#next(), heartbeatMs / 1000, new Date(this.options.now?.() ?? Date.now()))); };
    beat();
    const every = setInterval(() => { if (Date.now() - this.lastFrameMs > heartbeatMs * 2.5) this.close("silent for too long"); else beat(); }, heartbeatMs);
    const unready = setTimeout(() => { if (!this.#ready) this.close("it did not answer the heartbeat"); }, options.timings?.readyMs ?? 15_000);
    every.unref(); unready.unref();
    this.#timers.add(every); this.#timers.add(unready);
  }

  close(reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#pending?.done(undefined);
    this.#wake?.();
    this.socket.destroy();
    if (reason !== undefined) this.options.log?.(`ARMOR_SOLAR_DONGLE=DISCONNECTED device=${this.device} reason="${reason}"`);
    this.onClose();
  }

  #next(): number { this.#transaction = (this.#transaction % 0xffff) + 1; return this.#transaction; }
  #send(data: Buffer): void { if (!this.#closed) this.socket.write(data); }

  #data(chunk: Buffer): void {
    const now = Date.now();
    if (now - this.#window.start >= 1000) this.#window = { start: now, bytes: 0, frames: 0 };
    this.#window.bytes += chunk.length;
    if (this.#window.bytes > this.config.max_bytes_per_s) return this.close("too many bytes");
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.length >= HEADER_SIZE) {
      const header = readHeader(this.#buffer, this.config.max_frame_bytes);
      if (!header) return this.close("a frame of an impossible or too large size");
      const total = HEADER_SIZE + header.payloadLength;
      if (this.#buffer.length < total) return;
      const payload = Buffer.from(this.#buffer.subarray(HEADER_SIZE, total));
      this.#buffer = Buffer.from(this.#buffer.subarray(total));
      this.#window.frames += 1;
      if (this.#window.frames > this.config.max_frames_per_s) return this.close("too many frames");
      this.#frame(header, payload);
    }
  }

  #frame(header: DongleHeader, payload: Buffer): void {
    this.lastFrameMs = Date.now();
    if (header.functionCode === FC_HEARTBEAT) {
      this.#reportedCode = header.deviceCode;   // the dongle's own name (the payload) is neither kept nor logged
      if (!this.#ready) { this.#ready = true; void this.#run().catch(error => this.close(error instanceof Error ? error.message.slice(0, 120) : "error")); }
      return;
    }
    if (header.functionCode !== FC_FORWARD) return this.close("an unexpected kind of frame");
    const pending = this.#pending;
    if (pending && header.transaction === pending.transaction && header.deviceCode === pending.deviceCode && header.address === pending.address) pending.done(payload);
  }

  /** One question; the text of the reply, or undefined when it did not come, was refused or its CRC is wrong. */
  #ask(question: Question, deviceCode: number, address: number): Promise<string | undefined> {
    return new Promise(resolve => {
      if (this.#closed) return resolve(undefined);
      const transaction = this.#next();
      const done = (reply: Buffer | undefined): void => {
        clearTimeout(timer); this.#timers.delete(timer); this.#pending = undefined;
        const text = reply ? replyText(reply) : undefined;
        resolve(text === "NAK" ? undefined : text);
      };
      const timer = setTimeout(() => done(undefined), this.options.timings?.requestTimeoutMs ?? this.config.request_timeout_s * 1000);
      this.#timers.add(timer);
      this.#pending = { transaction, deviceCode, address, done };
      this.#send(questionFrame(transaction, question, deviceCode, address));
    });
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { this.#wake = undefined; this.#timers.delete(timer); resolve(); };
      const timer = setTimeout(done, ms);
      this.#timers.add(timer);
      this.#wake = done;
    });
  }

  /** Finds how the inverter is reached and which protocol it speaks, asking only for its protocol number. */
  async #discover(): Promise<Route | "unsupported" | undefined> {
    const codes = [...new Set([this.#reportedCode, ...KNOWN_DEVICE_CODES].filter(code => code > 0))];
    const wanted = this.config.protocol;
    for (const address of [1, 255]) {
      for (const deviceCode of codes) {
        if (wanted !== "pi18") {
          const answer = await this.#ask("QPI", deviceCode, address);
          if (answer === "PI30") return { protocol: "pi30", deviceCode, address };
          if (answer !== undefined && /^PI\d{2}$/.test(answer)) return this.#unsupported(answer);
        }
        if (wanted !== "pi30") {
          const answer = await this.#ask("PI", deviceCode, address);
          if (answer === "18") return { protocol: "pi18", deviceCode, address };
          if (answer !== undefined && /^\d{2}$/.test(answer)) return this.#unsupported(`PI${answer}`);
        }
        if (this.#closed) return undefined;
      }
    }
    return undefined;
  }

  #unsupported(name: string): "unsupported" {
    this.options.warn?.(`ARMOR_SOLAR_DONGLE=UNSUPPORTED_PROTOCOL device=${this.device} protocol=${name} (PI30 and PI18 are read; nothing more is asked on this connection)`);
    return "unsupported";
  }

  async #run(): Promise<void> {
    const pollMs = this.options.timings?.pollMs ?? this.config.poll_s * 1000;
    let route: Route | undefined;
    while (!this.#closed && !route) {
      const found = await this.#discover();
      if (found === "unsupported") return;
      route = found;
      if (!route && !this.#closed) { this.options.warn?.(`ARMOR_SOLAR_DONGLE=NO_INVERTER device=${this.device} (the dongle is connected and the inverter does not answer)`); await this.#sleep(pollMs * 6); }
    }
    if (!route) return;
    const { protocol, deviceCode, address } = route;
    const ask = (question: Question): Promise<string | undefined> => this.#ask(question, deviceCode, address);
    this.options.log?.(`ARMOR_SOLAR_DONGLE=READING device=${this.device} protocol=${protocol}`);

    const identity: { serial?: string; firmware?: string; ratings?: Ratings } = {};
    const serial = await ask(protocol === "pi30" ? "QID" : "ID");
    // PI18 answers the length of the number and then the number, padded with zeros
    identity.serial = serial === undefined ? undefined : parseSerial(protocol === "pi30" ? serial : serial.slice(2, 2 + Number(serial.slice(0, 2))));
    const firmware = await ask(protocol === "pi30" ? "QVFW" : "VFW");
    identity.firmware = firmware === undefined ? undefined : parseFirmware(protocol === "pi30" ? firmware : firmware.split(",")[0]);
    if (protocol === "pi30") { const ratings = await ask("QPIRI"); identity.ratings = ratings === undefined ? undefined : parseQpiri(ratings); }

    let pv2Misses = 0, statusMisses = 0;
    while (!this.#closed) {
      const modeText = await ask(protocol === "pi30" ? "QMOD" : "MOD");
      const statusText = await ask(protocol === "pi30" ? "QPIGS" : "GS");
      const status = statusText === undefined ? undefined : protocol === "pi30" ? parseQpigs(statusText) : parseGs(statusText);
      if (this.#closed) return;
      if (!status) {
        statusMisses += 1;
        if (statusMisses >= 3) return this.close("the inverter stopped answering");
        await this.#sleep(pollMs);
        continue;
      }
      statusMisses = 0;
      let pv2: ReturnType<typeof parseQpigs2>;
      if (protocol === "pi30" && pv2Misses < 2) {
        const text = await ask("QPIGS2");
        pv2 = text === undefined ? undefined : parseQpigs2(text);
        pv2Misses = pv2 ? 0 : pv2Misses + 1;
      }
      const warningText = await ask(protocol === "pi30" ? "QPIWS" : "FWS");
      const warnings = warningText === undefined ? undefined : protocol === "pi30" ? parseQpiws(warningText) : parseFws(warningText);
      if (this.#closed) return;
      const { clamped, ...numbers } = status;
      this.options.publish({
        kind: "inverter", node_id: this.config.node_id, device: this.device, timestamp_ms: this.options.now?.() ?? Date.now(),
        mode: (modeText === undefined ? undefined : protocol === "pi30" ? parseQmod(modeText) : parseMod18(modeText)) ?? "unknown",
        ...numbers,
        warnings: warnings ?? [],
        ...(warnings ? {} : { warnings_known: false }),
        ...(clamped.length ? { clamped } : {}),
        ...(pv2 ? { ...pv2, pv_w: Math.min(100_000, numbers.pv_w + pv2.pv2_w) } : {}),
        ...(identity.serial ? { serial: identity.serial } : {}),
        ...(identity.firmware ? { firmware: identity.firmware } : {}),
        ...(identity.ratings ? { ratings: identity.ratings } : {}),
      });
      await this.#sleep(pollMs);
    }
  }
}

export class SolarDongle {
  #server: net.Server | undefined;
  #config: DongleConfig | undefined;
  #sessions = new Map<string, Session>();
  #recent = new Map<string, number[]>();
  #busy: Promise<void> = Promise.resolve();
  #said = "";
  #closed = false;
  #refusedSaidMs = 0;

  constructor(private readonly options: SolarDongleOptions) {}

  /** The node name its readings carry, once a configuration was taken. */
  get nodeId(): string | undefined { return this.#config?.node_id; }
  /** The port it listens on, or undefined while nothing is open. */
  get port(): number | undefined { const address = this.#server?.address(); return address && typeof address === "object" ? address.port : undefined; }

  /** Follows the option: opens the port when it is on and the file is good, closes it (and every dongle) when it is off. Called now and then; never throws. */
  sync(): Promise<void> {
    this.#busy = this.#busy.then(() => this.#follow()).catch(error => this.#once(`ARMOR_SOLAR_DONGLE=FAILED ${error instanceof Error ? error.message : "unknown error"}`));
    return this.#busy;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#busy;
    await this.#stop();
  }

  #once(line: string): void { if (line !== this.#said) { this.#said = line; this.options.warn?.(line); } }

  async #follow(): Promise<void> {
    if (this.#closed || !this.options.enabled()) {
      if (this.#server) { await this.#stop(); this.options.log?.("ARMOR_SOLAR_DONGLE=OFF (the port is closed)"); }
      this.#said = "";
      return;
    }
    if (this.#server) return;
    let config: DongleConfig;
    try { config = parseDongleConfig(JSON.parse(fs.readFileSync(this.options.file, "utf8"))); }
    catch (error) {
      const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "there is no file" : error instanceof SyntaxError ? "the file is not valid JSON" : (error as Error).message;
      return this.#once(`ARMOR_SOLAR_DONGLE=NOT_LISTENING ${this.options.file}: ${why}`);
    }
    const server = net.createServer(socket => this.#accept(socket));
    server.maxConnections = config.dongles.length * 2 + 2;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.listen_address, () => { server.removeListener("error", reject); resolve(); }); });
    } catch (error) { return this.#once(`ARMOR_SOLAR_DONGLE=NOT_LISTENING address=${config.listen_address}:${config.port} ${(error as NodeJS.ErrnoException).code ?? "error"}`); }
    server.on("error", error => this.#once(`ARMOR_SOLAR_DONGLE=FAILED ${error.message}`));
    this.#config = config;
    this.#server = server;
    this.#said = "";
    this.options.log?.(`ARMOR_SOLAR_DONGLE=LISTENING address=${config.listen_address}:${config.port} dongles=${config.dongles.length} (reading only; a dongle is pointed here by hand)`);
  }

  async #stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const session of [...this.#sessions.values()]) session.close();
    this.#sessions.clear();
    this.#recent.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  #accept(socket: net.Socket): void {
    socket.on("error", () => undefined);
    const config = this.#config;
    const address = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const dongle = config?.dongles.find(item => item.address === address);
    const now = Date.now();
    if (!config || !dongle || !this.options.enabled()) {
      socket.destroy();
      if (now - this.#refusedSaidMs > 60_000) { this.#refusedSaidMs = now; this.options.warn?.(`ARMOR_SOLAR_DONGLE=REFUSED a connection from ${address || "an unknown address"}, which is not in the list`); }
      return;
    }
    const recent = (this.#recent.get(address) ?? []).filter(time => now - time < 60_000);
    if (recent.length >= config.connections_per_minute) { socket.destroy(); return; }
    this.#recent.set(address, [...recent, now]);
    const held = this.#sessions.get(address);
    // a dongle that calls again has usually given up on the first connection; one that was heard a moment ago is kept
    if (held) {
      if (now - held.lastFrameMs < (this.options.timings?.requestTimeoutMs ?? config.request_timeout_s * 1000) * 2) { socket.destroy(); return; }
      held.close("replaced by a new connection of the same dongle");
    }
    const session: Session = new Session(socket, dongle.device, config, this.options, () => { if (this.#sessions.get(address) === session) this.#sessions.delete(address); });
    this.#sessions.set(address, session);
    this.options.log?.(`ARMOR_SOLAR_DONGLE=CONNECTED device=${dongle.device} address=${address}`);
  }
}
