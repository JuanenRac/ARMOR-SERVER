/**
 * The signed copy of the state of an alarm node. A panel publishes its state on armor/alarm/{node}/state without a signature, so a reader on the broker (the safety zones of a HYDRA-UMC
 * cell, for one) cannot tell who sent it. While the option `server.alarm_state_signature` is on, the server publishes each state it hears once more on the same topic with `seq` and
 * `sig` added: HMAC-SHA256 over `armor-alarm-state|node_id|timestamp_ms|phase|mode|siren|locked_out|commands_enabled|open_zones|zones|seq` with the key of the installation, a file of
 * this server that never travels on the broker (the format is in ARMOR-COMMON, docs/CONTRACTS.md, and its vectors in conformance/signatures/alarm_state.json). `seq` is the time in
 * milliseconds and only goes up. The copy changes nothing the server itself does: it ignores a state whose signature is its own.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { durableRename } from "./durable.js";
import type { AlarmMessage } from "./alarm.js";

/** The bytes a state is signed over (see alarm_state_canonical in ARMOR-COMMON). */
export function alarmStateCanonical(message: AlarmMessage, seq: number): string {
  const flag = (value: boolean): string => (value ? "1" : "0");
  const zones = message.zones.map(zone => `${zone.id}:${zone.state}:${flag(zone.bypassed)}`).join(",");
  return ["armor-alarm-state", message.node_id, String(message.timestamp_ms), message.phase, message.mode, flag(message.siren), flag(message.locked_out), flag(message.commands_enabled),
    message.open_zones.join(","), zones, String(seq)].join("|");
}

export function alarmStateSignature(keyHex: string, message: AlarmMessage, seq: number): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(alarmStateCanonical(message, seq), "utf8").digest("hex");
}

export type SignedAlarmState = AlarmMessage & { seq: number; sig: string };

export class AlarmStateSigner {
  #key: string | undefined;
  #last = 0;

  /** `file` holds the key as 64 hex characters (0600); it is made the first time a state is signed, never before. */
  constructor(private readonly file: string, private readonly now: () => number = () => Date.now()) {
    this.#key = this.#read();
  }

  #read(): string | undefined {
    try { const text = fs.readFileSync(this.file, "utf8").trim(); return /^[0-9a-f]{64}$/.test(text) ? text : undefined; } catch { return undefined; }
  }

  #ensure(): string {
    if (this.#key) return this.#key;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600 });
    durableRename(temporary, this.file);
    this.#key = this.#read();
    if (!this.#key) throw new Error("the key of the alarm states cannot be read");
    return this.#key;
  }

  /** The state with `seq` and `sig` added. `seq` is above every one this signer made before, also when two states fall in the same millisecond. */
  sign(message: AlarmMessage): SignedAlarmState {
    const key = this.#ensure();
    const seq = Math.max(this.now(), this.#last + 1);
    this.#last = seq;
    return { ...message, seq, sig: alarmStateSignature(key, message, seq) };
  }

  /** Whether a state that arrives carries the signature of this installation (the copy this server published itself, heard again on the broker). */
  isOwn(value: unknown): boolean {
    if (!this.#key || typeof value !== "object" || value === null) return false;
    const { seq, sig, ...rest } = value as Record<string, unknown>;
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig) || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return false;
    try {
      const expected = Buffer.from(alarmStateSignature(this.#key, rest as unknown as AlarmMessage, seq), "hex");
      return timingSafeEqual(expected, Buffer.from(sig, "hex"));
    } catch { return false; }
  }
}
